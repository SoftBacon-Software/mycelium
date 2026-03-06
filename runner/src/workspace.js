// Git workspace manager — clones/pulls repos for containerized environments

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as logger from './logger.js';
import { isGitHubDown } from './github-status.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: 'pipe', timeout: 120000, ...opts }).toString().trim();
}

export function ensureWorkspace(agentConfig) {
  if (!agentConfig.repos || agentConfig.repos.length === 0) return;

  for (const repo of agentConfig.repos) {
    const dest = repo.path || `${WORKSPACE_ROOT}/${agentConfig.id}/${repo.name}`;
    const branch = repo.branch || 'main';

    if (existsSync(dest + '/.git')) {
      if (isGitHubDown()) {
        logger.warn(agentConfig.id, `Skipping git pull for ${repo.name} — GitHub is down`);
      } else {
        // Pull latest
        logger.info(agentConfig.id, `Pulling ${repo.name}`, { dest, branch });
        try {
          git(['-C', dest, 'fetch', 'origin']);
          git(['-C', dest, 'reset', '--hard', `origin/${branch}`]);
        } catch (e) {
          logger.warn(agentConfig.id, `Pull failed for ${repo.name}: ${e.message}`);
        }
      }
    } else {
      // Clone — skip if GitHub is down (would hang/fail anyway)
      if (isGitHubDown()) {
        logger.warn(agentConfig.id, `Skipping clone for ${repo.name} — GitHub is down`);
        continue;
      }
      logger.info(agentConfig.id, `Cloning ${repo.name}`, { url: repo.url, dest, branch });
      mkdirSync(dest, { recursive: true });

      // Inject GitHub token if available
      let url = repo.url;
      const token = process.env.GITHUB_TOKEN;
      if (token && url.startsWith('https://github.com/')) {
        url = url.replace('https://github.com/', `https://${token}@github.com/`);
      }

      try {
        git(['clone', '--depth', '10', '-b', branch, url, dest], { timeout: 300000 });
      } catch (e) {
        logger.error(agentConfig.id, `Clone failed for ${repo.name}: ${e.message}`);
        throw e;
      }
    }

    // Configure git user for commits
    try {
      git(['-C', dest, 'config', 'user.email', `${agentConfig.id}@mycelium.fyi`]);
      git(['-C', dest, 'config', 'user.name', agentConfig.id]);
    } catch (e) { /* non-critical */ }

    // Update cwd to point at the first repo if not explicitly set
    if (!agentConfig._cwdExplicit) {
      agentConfig.cwd = dest;
      agentConfig._cwdExplicit = true;
    }
  }
}

export function pushChanges(agentConfig) {
  if (!agentConfig.repos) return;

  for (const repo of agentConfig.repos) {
    const dest = repo.path || `${WORKSPACE_ROOT}/${agentConfig.id}/${repo.name}`;
    if (!existsSync(dest + '/.git')) continue;

    try {
      const unpushed = git(['-C', dest, 'log', '--oneline', '@{u}..HEAD']);
      if (unpushed) {
        logger.info(agentConfig.id, `Pushing changes for ${repo.name}`, { commits: unpushed.split('\n').length });
        git(['-C', dest, 'push', 'origin', 'HEAD'], { timeout: 120000 });
      }
    } catch (e) {
      logger.warn(agentConfig.id, `Push failed for ${repo.name}: ${e.message}`);
    }
  }
}
