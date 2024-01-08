import fs from "fs";
import { $fetch } from "ofetch";
import ora from "ora";
import os from "os";
import path from "path";
import { Module, files, git, docker, helpers, ModuleCategory, Logger } from "zksync-cli/lib";

import type { ConfigHandler, NodeInfo } from "zksync-cli/lib";

const REPO_URL = "matter-labs/block-explorer";
const APP_RUNTIME_CONFIG_PATH = "/usr/src/app/packages/app/dist/config.js";
const DOCKER_DATABASE_VOLUME_NAME = "postgres";
const endpoints = {
  app: "http://localhost:3010",
  api: "http://localhost:3020",
};

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
        rpcUrl: "http://localhost:3050",
      },
    ],
  },
};

let latestVersion: string | undefined;

export default class SetupModule extends Module<ModuleConfig> {
  private readonly localFolder: string;

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
    return this.getInstalledModuleFilePath("docker-compose.yml");
  }

  async getL2Network(): Promise<NodeInfo["l2"]> {
    const nodeInfo = await this.configHandler.getNodeInfo();
    return nodeInfo.l2;
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

    try {
      fs.writeFileSync(appConfigPath, appConfig, "utf-8");
    } catch (error) {
      throw new Error(`Error writing to app config file: ${error}`);
    }

    const commandError = await helpers.executeCommand(
      `docker compose cp ${appConfigPath} app:${APP_RUNTIME_CONFIG_PATH}`,
      { silent: true, cwd: this.dataDirPath }
    );

    if (commandError) {
      throw new Error(`Error while copying app config to the app container: ${commandError}`);
    }
  }

  async install() {
    try {
      const l2Network = await this.getL2Network();
      const version = await this.getLatestVersion();

      if (!fs.existsSync(this.dataDirPath)) {
        Logger.debug("Creating module folder...");
        fs.mkdirSync(this.dataDirPath);
      }

      Logger.debug("Copying module configuration files...");
      fs.copyFileSync(this.getLocalFilePath("../docker-compose.yml"), this.installedComposeFile);

      const rpcPort = l2Network.rpcUrl.split(":").at(-1) || "3050";
      const envFileContent = `VERSION=${version}${os.EOL}RPC_PORT=${rpcPort}`;
      try {
        fs.writeFileSync(this.getInstalledModuleFilePath(".env"), envFileContent, "utf-8");
      } catch (error) {
        throw new Error(`Error writing to .env file: ${error}`);
      }

      await docker.compose.create(this.installedComposeFile);

      Logger.debug("Applying App config...");
      await this.applyAppConfig(l2Network);

      Logger.debug("Saving module config...");
      this.setModuleConfig({
        ...this.moduleConfig,
        version: version,
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
      `App: ${endpoints.app}`,
      {
        text: "HTTP API:",
        list: [`Endpoint: ${endpoints.api}`, `Documentation: ${endpoints.api}/docs`],
      },
    ];
  }

  get version() {
    return this.moduleConfig.version ?? undefined;
  }

  async getLatestVersion(): Promise<string> {
    if (!latestVersion) {
      latestVersion = await git.getLatestReleaseVersion(REPO_URL);
    }
    return latestVersion;
  }

  async cleanupIndexedData() {
    await Promise.all(
      ["worker", "api", "postgres"].map((serviceName) =>
        helpers.executeCommand(`docker compose rm -fsv ${serviceName}`, { silent: true, cwd: this.dataDirPath })
      )
    );

    const fullDatabaseName = `${this.package.name}_${DOCKER_DATABASE_VOLUME_NAME}`;
    const volumes = await helpers.executeCommand("docker volume ls", { silent: true });
    if (volumes?.includes(fullDatabaseName)) {
      await helpers.executeCommand(`docker volume rm ${fullDatabaseName}`, { silent: true });
    }
  }

  async getNodeLatestBlockNumber(): Promise<number> {
    const l2Network = await this.getL2Network();
    try {
      const response = await $fetch(l2Network.rpcUrl, {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        }),
      });
      const blockNumber = parseInt(response.result, 16);
      if (isNaN(blockNumber)) {
        throw new Error(`Unexpected response from L2 node: ${JSON.stringify(response)}`);
      }
      return blockNumber;
    } catch (error) {
      throw new Error(`Failed to get latest block number from L2 node: ${error}`);
    }
  }

  async getApiLatestBlockNumber(): Promise<number> {
    const response = await $fetch(`${endpoints.api}/blocks`);
    return response.items[0]?.number ?? 0;
  }

  /**
   * @summary Waits for full indexing of the L2 node
   * @description Gets latest block number from the L2 node and Block Explorer API and compares them.
   **/
  async waitForFullIndexing() {
    const spinner = ora("Initializing Block Explorer API...").start();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let apiLatestBlockNumber: number;
      try {
        apiLatestBlockNumber = await this.getApiLatestBlockNumber();
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      try {
        const nodeLatestBlockNumber = await this.getNodeLatestBlockNumber();

        if (apiLatestBlockNumber === nodeLatestBlockNumber) {
          spinner.succeed("Block Explorer initialized");
          return;
        }

        spinner.text = `Block Explorer is processing the data. Blocks processed: ${apiLatestBlockNumber}/${nodeLatestBlockNumber}`;
      } catch (error) {
        spinner.fail("Failed to get node latest block number");
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async start() {
    await this.cleanupIndexedData();
    await docker.compose.up(this.installedComposeFile);
    await this.waitForFullIndexing();
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
