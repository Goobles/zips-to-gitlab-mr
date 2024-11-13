import axios from "axios";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises,
  readdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import simpleGit from "simple-git";
import { Parse } from "unzipper";

const envBasedConfig = {
  repoUrl: process.env.REPO_URL,
  baseBranch: process.env.BASE_BRANCH ?? "main",
  gitlabToken: process.env.GITLAB_TOKEN,
  projectId: process.env.GITLAB_PROJECT_ID,
  branchNamePrefix: process.env.BRANCH_NAME_PREFIX ?? "script-branch",
  knownDirectories: process.env.KNOWN_DIRECTORIES?.split(";"),
};

async function main({
  repoUrl,
  gitlabToken,
  projectId,
  baseBranch,
  knownDirectories,
  branchNamePrefix,
} = envBasedConfig) {
  //create zip dir if not exists
  if (!existsSync(join(process.cwd(), "zips"))) {
    mkdirSync(join(process.cwd(), "zips"));
  }

  //load all zip file names from the /zips directory
  const zipFiles = readdirSync(join(process.cwd(), "zips"))
    .filter((file) => file.endsWith(".zip"))
    .map((file) => join("zips/", file));

  const repoDir = join(process.cwd(), "repository");

  // remove repo directory if it exists
  if (existsSync(repoDir)) {
    await promises.rm(repoDir, { recursive: true, force: true });
  }
  mkdirSync(repoDir);
  process.env.DEBUG = "simple-git";
  // Clone repository if needed and checkout base branch
  const git = simpleGit(repoDir, {});
  await git.clone(repoUrl, repoDir);

  await git.fetch();
  await git.checkout(baseBranch);

  // Recursively find folders named Q1, Q2, or Q3 in the zip's extracted content
  /**
   * @param {string} srcDir
   * @param {string} destDir
   */
  async function findAndCopyQFolders(srcDir, destDir) {
    const items = await promises.readdir(srcDir, { withFileTypes: true });

    for (const item of items) {
      const itemPath = join(srcDir, item.name);

      if (item.isDirectory()) {
        if (knownDirectories.includes(item.name)) {
          const targetPath = join(destDir, item.name);
          await copyDirectory(itemPath, targetPath);
        } else {
          await findAndCopyQFolders(itemPath, destDir); // Recurse into subfolders
        }
      }
    }
  }

  // Helper function to copy contents of one directory to another
  async function copyDirectory(src, dest) {
    await promises.mkdir(dest, { recursive: true });
    const entries = await promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath);
      } else {
        await promises.copyFile(srcPath, destPath);
      }
    }
  }

  // Process each zip file: extract, locate Q folders, copy, and push with MR creation
  /**
   * @param {string} zipFile
   */
  async function processZipFile(zipFile) {
    const branchName = `${branchNamePrefix}-${basename(zipFile, ".zip")}`;
    const tmpDir = join(process.cwd(), `${basename(zipFile, ".zip")}`);

    // Create a temporary directory and extract the zip file
    await promises.mkdir(tmpDir, { recursive: true });
    //await fs.createReadStream(zipFile).pipe(unzip.Extract({ path: tmpDir })).promise();
    await unzipFile(zipFile, tmpDir);

    // Remove any .git folders in the extracted content
    await removeGitFolders(tmpDir);

    // Locate and copy Q folders from extracted content to the repository
    await findAndCopyQFolders(tmpDir, repoDir);

    // Create branch, commit changes, and push with MR
    await git.checkoutLocalBranch(branchName);
    await git.add(".");
    await git.commit(`Add files from ${basename(zipFile)}`);

    await pushAndCreateMergeRequest(
      branchName,
      baseBranch,
      gitlabToken,
      projectId
    );

    // Clean up the temporary directory
    await promises.rm(tmpDir, { recursive: true, force: true });
  }

  /**
   * @param {string} branchName
   * @param {string} baseBranch
   * @param {string} gitlabToken
   * @param {string} projectId
   */
  async function pushAndCreateMergeRequest(
    branchName,
    baseBranch,
    gitlabToken,
    projectId
  ) {
    // Step 1: Push the branch
    await git.push(["-u", "origin", branchName, "--force"]);

    // Step 2: Create a merge request via GitLab API
    const apiUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(
      projectId
    )}/merge_requests`;

    try {
      const response = await axios.post(
        apiUrl,
        {
          source_branch: branchName,
          target_branch: baseBranch,
          title: `Merge ${branchName} into ${baseBranch}`,
        },
        {
          headers: { "PRIVATE-TOKEN": gitlabToken },
        }
      );

      console.log("Merge request created:", response.data.web_url);
    } catch (error) {
      console.error(
        "Error creating merge request:",
        error.response?.data || error.message
      );
    }
  }

  /**
   * @param {import("fs").PathLike} zipFilePath
   * @param {string} outputDir
   */
  async function unzipFile(zipFilePath, outputDir) {
    return new Promise((resolve, reject) => {
      createReadStream(zipFilePath)
        .pipe(Parse())
        .on("entry", async (entry) => {
          const entryPath = join(outputDir, entry.path);

          if (entry.type === "Directory") {
            // Ensure the directory exists
            await promises.mkdir(entryPath, { recursive: true });
            entry.autodrain();
          } else {
            // Ensure the parent directory exists for files
            await promises.mkdir(dirname(entryPath), { recursive: true });
            entry.pipe(createWriteStream(entryPath));
          }
        })
        .on("close", resolve)
        .on("error", reject);
    });
  }

  // Helper to remove any .git folders found in the extracted files
  /**
   * @param {string} dir
   */
  async function removeGitFolders(dir) {
    const items = await promises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const itemPath = join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === ".git") {
          await promises.rm(itemPath, { recursive: true, force: true });
        } else {
          await removeGitFolders(itemPath); // Recurse into subdirectories
        }
      }
    }
  }

  for (const zipFile of zipFiles) {
    await processZipFile(zipFile);
    await git.checkout(baseBranch);
  }
}

main().catch(console.error);
