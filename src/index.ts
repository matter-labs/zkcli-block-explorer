import os from "os";
import path from "path";
import { Module, files, git, docker, helpers, ModuleCategory, Logger } from "zksync-cli/lib";
import * as fs from "node:fs";
import type { ConfigHandler, NodeInfo } from "zksync-cli/lib";

const REPO_URL = "matter-labs/block-explorer";
const APP_RUNTIME_CONFIG_PATH = "/usr/src/app/packages/app/dist/config.js";

type ModuleConfig = {
  version?: string;
  l2Network?: NodeInfo["l2"];
};

const appConfigTemplate = {
  appEnvironment: "local",
  environmentConfig: {
    networks: [
      {
        apiUrl: "http://localhost:3020",
        bridgeUrl: "http://localhost:3000/bridge",
        hostnames: ["localhost"],
        icon: "/images/icons/zksync-arrows.svg",
        l2ChainId: 270,
        l2NetworkName: "Local Node",
        l2WalletUrl: "http://localhost:3000",
        maintenance: false,
        name: "local",
        newProverUrl: "https://storage.googleapis.com/zksync-era-testnet-proofs/proofs_fri",
        published: true,
        rpcUrl: "http://localhost:3050"
      }
    ]
  }
};

export default class SetupModule extends Module<ModuleConfig> {
  private readonly localFolder: string;
  private latestVersion?: string;

  constructor(config: ConfigHandler) {
    super(
      {
        name: "Block Explorer",
        description: "zkSync block explorer UI and API",
        category: ModuleCategory.Explorer,
      },
      config
    );
    this.localFolder = files.getDirPath(import.meta.url);
  }

  getLocalFilePath(fileName: string): string {
    return path.join(this.localFolder, fileName);
  }

  getInstalledModuleFilePath(fileName: string): string {
    return path.join(this.dataDirPath, fileName);
  }

  get installedComposeFile(): string {
    return this.getInstalledModuleFilePath("docker-compose.yml")
  }

  async getL2Network(): Promise<NodeInfo["l2"]> {
    const nodeInfo = await this.configHandler.getNodeInfo();
    return nodeInfo.l2;
  }

  isNodeSupported() {
    return true;
  }

  get startAfterNode() {
    return true;
  }

  async isInstalled() {
    if (!this.moduleConfig.version || !this.moduleConfig.l2Network) {
      return false;
    }

    const { chainId, rpcUrl } = this.moduleConfig.l2Network;
    const l2Network = await this.getL2Network();
    if (l2Network.chainId !== chainId || l2Network.rpcUrl !== rpcUrl) {
      return false;
    }

    return (await docker.compose.status(this.installedComposeFile)).length ? true : false;
  }

  async applyAppConfig(l2Network: NodeInfo["l2"]) {
    appConfigTemplate.environmentConfig.networks[0].rpcUrl = l2Network.rpcUrl;
    appConfigTemplate.environmentConfig.networks[0].l2ChainId = l2Network.chainId;

    const appConfigPath = this.getInstalledModuleFilePath("app-config.js");
    const appConfig = `window["##runtimeConfig"] = ${JSON.stringify(appConfigTemplate)};`;

    fs.writeFileSync(appConfigPath, appConfig, "utf-8");

    const commandError = await helpers.executeCommand(
      `docker cp ${appConfigPath} zkcli-block-explorer-app-1:${APP_RUNTIME_CONFIG_PATH}`,
      { silent: true, cwd: this.dataDirPath }
    );

    if (commandError) {
      throw new Error(`Error while copying app config to the app container: ${commandError}`);
    }
  }

  async install() {
    try {
      const l2Network = await this.getL2Network();
      const latestVersion = await this.getLatestVersion();

      if (!fs.existsSync(this.dataDirPath)) {
        Logger.info("Creating module folder...");
        fs.mkdirSync(this.dataDirPath);
      }

      Logger.info("Copying module configuration files...");
      fs.copyFileSync(this.getLocalFilePath("../docker-compose.yml"), this.installedComposeFile);

      const rpcPort = l2Network.rpcUrl.split(":").at(-1) || "3050";
      const envFileContent = `VERSION=${latestVersion}${os.EOL}RPC_PORT=${rpcPort}`;
      fs.writeFileSync(this.getInstalledModuleFilePath(".env"), envFileContent, "utf-8");

      await docker.compose.create(this.installedComposeFile);

      Logger.info("Applying App config...");
      await this.applyAppConfig(l2Network);

      Logger.info("Saving module config...");
      this.setModuleConfig({
        ...this.moduleConfig,
        version: latestVersion,
        l2Network,
      });
    } catch (error) {
      if (error?.toString().includes("operation not permitted")) {
        throw new Error(
          "Not enough permissions to create necessary files. Please run console in administrator mode and try again."
        );
      }
      throw error;
    }
  }

  getStartupInfo() {
    return [
      "App: http://localhost:3010",
      {
        text: "HTTP API:",
        list: ["Endpoint: http://localhost:3020", "Documentation: http://localhost:3020/docs"],
      },
    ];
  }

  get version() {
    return this.moduleConfig.version ?? undefined;
  }

  async getLatestVersion(): Promise<string> {
    if (!this.latestVersion) {
      this.latestVersion = await git.getLatestReleaseVersion(REPO_URL);
    }
    return this.latestVersion;
  }

  async cleanupIndexedData() {
    const moduleDockerVolume = "zkcli-block-explorer_postgres";
    await Promise.all(["worker", "api", "postgres"].map(serviceName =>
      helpers.executeCommand(
        `docker-compose rm -fsv ${serviceName}`,
        { silent: true, cwd: this.dataDirPath }
      )
    ));

    const volumes = await helpers.executeCommand("docker volume ls", { silent: true });
    if (volumes?.includes(moduleDockerVolume)) {
      await helpers.executeCommand(`docker volume rm ${moduleDockerVolume}`, { silent: true });
    }
  }

  async start() {
    await this.cleanupIndexedData();
    await docker.compose.up(this.installedComposeFile);
  }

  async update() {
    await this.clean();
    await this.install();
  }

  async stop() {
    await docker.compose.stop(this.installedComposeFile);
  }

  async clean() {
    await docker.compose.down(this.installedComposeFile);
  }

  async isRunning() {
    return (await docker.compose.status(this.installedComposeFile)).some(({ isRunning }) => isRunning);
  }

  async getLogs() {
    return await docker.compose.logs(this.installedComposeFile);
  }
}
