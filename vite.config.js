import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

let outDir = 'dist'

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  plugins: [{
    // Commercial soundtrack: the dev server serves it, a build never ships it.
    name: 'keep-soundtrack-local',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    closeBundle() { rmSync(resolve(outDir, 'audio'), { recursive: true, force: true }) },
  }],
})
