import path from "path";
import { Module, files, git, docker, helpers, ModuleCategory, Logger } from "zksync-cli/lib";

import type { ConfigHandler, NodeInfo } from "zksync-cli/lib";

let latestVersion: string | undefined;

const REPO_URL = "matter-labs/block-explorer";

type ModuleConfig = {
  version?: string;
};

export default class SetupModule extends Module<ModuleConfig> {
  constructor(config: ConfigHandler) {
    super(
      {
        name: "Block Explorer",
        description: "zkSync block explorer UI and API",
        category: ModuleCategory.Explorer,
      },
      config
    );
  }

  gitUrl = `https://github.com/${REPO_URL}.git`;
  gitFolder = path.join(this.dataDirPath, "block-explorer");
  localComposeFile = path.join(files.getDirPath(import.meta.url), "../docker-compose.yml");
  composeFile = path.join(this.gitFolder, "zkcli-docker-compose.yaml");

  /**
   * Assumptions:
   * - If an L1 node is detected, we assume the user is utilizing the default dockerized testing node.
   * - If no L1 node is found, it's assumed the user is using the default in-memory node.
   *
   * Limitation:
   * This method does not account for custom RPC URLs. This limitation should be addressed in future
   * iterations of this module.
   */
  isNodeSupported(nodeInfo: NodeInfo) {
    if (nodeInfo.l1) {
      return true;
    }
    return false;
  }

  isRepoCloned() {
    return files.fileOrDirExists(this.gitFolder);
  }
  createDockerComposeSymlink() {
    files.createSymlink(this.localComposeFile, this.composeFile);
  }
  isDockerComposeCreated() {
    return files.fileOrDirExists(this.composeFile);
  }
  async isInstalled() {
    if (!this.isRepoCloned() || !this.isDockerComposeCreated()) return false;

    return (await docker.compose.status(this.composeFile)).length ? true : false;
  }
  async install() {
    await git.cloneRepo(this.gitUrl, this.gitFolder);
    const latestVersion = (await this.getLatestVersionFromLocalRepo())!;
    await this.gitCheckoutVersion(latestVersion);
    if (!this.isDockerComposeCreated()) {
      this.createDockerComposeSymlink();
    }
    await docker.compose.create(this.composeFile);
    this.setModuleConfig({
      ...this.moduleConfig,
      version: latestVersion,
    });
  }

  async isRunning() {
    return (await docker.compose.status(this.composeFile)).some(({ isRunning }) => isRunning);
  }
  get startAfterNode() {
    return true;
  }
  async start() {
    await docker.compose.up(this.composeFile);
  }
  getStartupInfo() {
    return [
      "App: http://localhost:3010/?network=local",
      {
        text: "HTTP API:",
        list: ["Endpoint: http://localhost:3020", "Documentation: http://localhost:3030"],
      },
    ];
  }

  async getLogs() {
    return await docker.compose.logs(this.composeFile);
  }

  get version() {
    return this.moduleConfig.version?.toString() ?? undefined;
  }
  async gitCheckoutVersion(version: string) {
    await helpers.executeCommand(`git checkout ${version}`, { silent: true, cwd: this.gitFolder });
  }
  async gitFetchTags() {
    await helpers.executeCommand("git fetch --tags", { silent: true, cwd: this.gitFolder });
  }
  async getLatestVersionFromLocalRepo(): Promise<string> {
    const commitHash = (
      await helpers.executeCommand("git rev-list --tags --max-count=1", {
        silent: true,
        cwd: this.gitFolder,
      })
    )?.trim();
    if (!commitHash?.length) {
      throw new Error(`Failed to parse latest version hash from the local repository: ${commitHash}`);
    }

    const version = (
      await helpers.executeCommand(`git describe --tags ${commitHash}`, {
        silent: true,
        cwd: this.gitFolder,
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
    await docker.compose.stop(this.composeFile);
  }

  async clean() {
    await docker.compose.down(this.composeFile);
  }
}
