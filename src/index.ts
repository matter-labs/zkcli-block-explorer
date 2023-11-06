import path from "path";
import { Module, files, git, docker, helpers, ModuleCategory, Logger } from "zksync-cli/lib";
import * as fs from "node:fs";
import type { ConfigHandler, NodeInfo } from "zksync-cli/lib";

let latestVersion: string | undefined;

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
  private readonly gitUrl: string;

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
    this.gitUrl = `https://github.com/${REPO_URL}.git`;
  }

  get installedModuleFolder() {
    return path.join(this.dataDirPath, "./block-explorer");
  }
  get installedComposeFile() {
    return path.join(this.installedModuleFolder, "zkcli-docker-compose.yaml");
  }

  getLocalFilePath(fileName: string): string {
    return path.join(this.localFolder, fileName);
  }

  async getL2Network(): Promise<NodeInfo["l2"]> {
    const nodeInfo = await this.configHandler.getNodeInfo();
    return nodeInfo.l2;
  }

  isNodeSupported() {
    return true;
  }

  isRepoCloned() {
    return files.fileOrDirExists(this.installedModuleFolder);
  }

  async isInstalled() {
    if (!this.moduleConfig.version || !this.moduleConfig.l2Network || !this.isRepoCloned()) {
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

    const appConfigPath = path.join(this.installedModuleFolder, "app-config.js");
    const appConfig = `window["##runtimeConfig"] = ${JSON.stringify(appConfigTemplate)};`;

    fs.writeFileSync(appConfigPath, appConfig, "utf-8");

    const commandError = await helpers.executeCommand(
      `docker cp ${appConfigPath} block-explorer-app-1:${APP_RUNTIME_CONFIG_PATH}`,
      { silent: true, cwd: this.installedModuleFolder }
    );

    if (commandError) {
      throw new Error(`Error while copying app config to the app container: ${commandError}`);
    }
  }

  async install() {
    try {
      const l2Network = await this.getL2Network();
      await git.cloneRepo(this.gitUrl, this.installedModuleFolder);

      const latestVersion = (await this.getLatestVersionFromLocalRepo())!;
      await this.gitCheckoutVersion(latestVersion);

      Logger.info("Copying module configuration files...");
      fs.copyFileSync(this.getLocalFilePath("../docker-compose.yml"), this.installedComposeFile);
      const rpcPort = l2Network.rpcUrl.split(":").at(-1) || "3050";
      fs.writeFileSync(path.join(this.installedModuleFolder, ".env"), `RPC_PORT=${rpcPort}`, "utf-8");

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

  async isRunning() {
    return (await docker.compose.status(this.installedComposeFile)).some(({ isRunning }) => isRunning);
  }

  get startAfterNode() {
    return true;
  }

  async start() {
    await docker.compose.up(this.installedComposeFile);
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

  async getLogs() {
    return await docker.compose.logs(this.installedComposeFile);
  }

  get version() {
    return this.moduleConfig.version ?? undefined;
  }

  async gitCheckoutVersion(version: string) {
    await helpers.executeCommand(`git checkout ${version}`, { silent: true, cwd: this.installedModuleFolder });
  }

  async gitFetchTags() {
    await helpers.executeCommand("git fetch --tags", { silent: true, cwd: this.installedModuleFolder });
  }

  async getLatestVersionFromLocalRepo(): Promise<string> {
    const commitHash = (
      await helpers.executeCommand("git rev-list --tags --max-count=1", {
        silent: true,
        cwd: this.installedModuleFolder,
      })
    )?.trim();
    if (!commitHash?.length) {
      throw new Error(`Failed to parse latest version hash from the local repository: ${commitHash}`);
    }

    const version = (
      await helpers.executeCommand(`git describe --tags ${commitHash}`, {
        silent: true,
        cwd: this.installedModuleFolder,
      })
    )?.trim();
    if (!version?.length || !version.startsWith("v")) {
      throw new Error(`Failed to parse latest version from the local repository: ${version}`);
    }
    return version;
  }

  async getLatestVersion(): Promise<string> {
    if (latestVersion) {
      return latestVersion;
    }
    if (!this.isRepoCloned()) {
      latestVersion = await git.getLatestReleaseVersion(REPO_URL);
    } else {
      try {
        await this.gitFetchTags();
      } catch (error) {
        Logger.warn(`Failed to fetch tags for Block Explorer: ${error}. Version may be outdated.`);
      }
      latestVersion = await this.getLatestVersionFromLocalRepo();
    }
    return latestVersion;
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
}
