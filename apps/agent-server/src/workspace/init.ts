import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { renderAgentsMd } from '@cw/harness-config';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { Git } from './git.js';

const GITIGNORE = `# managed by the agent platform
.agent/steps/*.tmp
__pycache__/
.venv/
node_modules/
*.pyc
`;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Boot step 2+3 (spec §5.2): prepare the persistent directories and the workspace repository. */
export async function prepareWorkspace(config: Config): Promise<Git> {
  for (const dir of [config.workspaceDir, config.artifactsDir, config.stagingDir, config.harnessDataDir]) {
    await mkdir(dir, { recursive: true });
  }
  const git = new Git(config.workspaceDir);
  const fresh = !(await exists(path.join(config.workspaceDir, '.git')));
  if (fresh) {
    logger.info({ dir: config.workspaceDir }, 'initializing workspace repository');
    await git.run(['init', '-q', '-b', 'main']);
  }
  await git.run(['config', 'user.name', config.AGENT_DISPLAY_NAME]);
  await git.run(['config', 'user.email', config.AGENT_GIT_EMAIL]);
  await git.run(['config', 'core.fsmonitor', 'false']);
  await git.run(['config', 'gc.auto', '0']);
  await git.run(['config', 'core.quotepath', 'false']);
  // The workspace volume can be owned by a different uid than the process (SMB on App Service).
  await git.run(['config', '--global', '--add', 'safe.directory', config.workspaceDir], { allowFail: true });

  if (fresh || !(await git.head())) {
    await mkdir(path.join(config.workspaceDir, '.agent', 'plans'), { recursive: true });
    await mkdir(path.join(config.workspaceDir, 'reports'), { recursive: true });
    await writeFile(path.join(config.workspaceDir, '.gitignore'), GITIGNORE);
    await writeFile(
      path.join(config.workspaceDir, 'AGENTS.md'),
      renderAgentsMd({ agentId: config.AGENT_ID, displayName: config.AGENT_DISPLAY_NAME }),
    );
    await writeFile(path.join(config.workspaceDir, '.agent', 'plans', '.gitkeep'), '');
    await writeFile(path.join(config.workspaceDir, 'reports', '.gitkeep'), '');
    await git.commitAll({ subject: 'chore: initialize workspace', trailers: { 'Requested-By': 'system' } });
  }
  return git;
}
