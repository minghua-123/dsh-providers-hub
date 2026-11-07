import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单测隔离：插件状态文档默认落在 `$DSH_HOME/jet-hub/`，测试必须改写到临时目录，
 * 否则会污染真实用户配置。每个 vitest 进程一个独立目录，用例之间不共享状态。
 */
const fallbackStateDir = mkdtempSync(join(tmpdir(), 'dsh-hub-lite-'))

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    env: {
      DSH_JET_HUB_STATE_DIR: fallbackStateDir,
    },
  },
})
