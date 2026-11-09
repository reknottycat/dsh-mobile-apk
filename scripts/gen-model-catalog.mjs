#!/usr/bin/env node
/**
 * gen-model-catalog.mjs — 从引擎树里的 pi-ai 厂商目录生成能力发现用的目录快照（0.13.5 W3）。
 *
 * 为什么需要：用户手填的自定义供应商路由（issue #125）没有任何能力元数据——
 * 自定义供应商面板只写 id/name/contextWindow/maxTokens，composer 因此没有思考档位可渲染。
 * 被动探测拿不到（通用 OpenAI 兼容 /models 不回能力字段），接受性探测不可信
 * （中转网关对任意 reasoning_effort 都回 200，2026-09-10 实测）。
 * 但引擎自带的 pi-ai 厂商目录**已声明**这些能力（thinkingLevelMap/input/compat），
 * 按精确模型 id 查表是「读厂商声明」而不是「按名字猜」。
 *
 * 输出：plugins/dsh-model-capability/lib/catalog-snapshot.json（随插件注入快照）。
 * 可复现：generatedAt 取 SOURCE_DATE_EPOCH（默认 1704067200），内容相同的两次生成字节一致。
 *
 * 用法：node scripts/gen-model-catalog.mjs [--engine-root <snapshotRoot> | --snapshot <snapshot.tar.xz>] [--out <file>]
 *   默认 engine-root 依次尝试：
 *     .deploy-tmp/snapshot-013/x86_64/stage/root
 *     \\wsl.localhost\<distro>\root\.dsh-stage\x86_64   （0.13.5 W5 之后的 ext4 工作区）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { wslHostPath } from './lib/shell.mjs'
import { modelCapabilities } from './lib/model-catalog.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const OUT = resolve(argOf('--out', join(ROOT, 'plugins', 'dsh-model-capability', 'lib', 'catalog-snapshot.json')))
const PI_SUBPATH = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai'

const candidates = [
  argOf('--engine-root', ''),
  join(ROOT, '.deploy-tmp', 'snapshot-013', 'x86_64', 'stage', 'root'),
  join(ROOT, '.deploy-tmp', 'snapshot-013', 'arm64', 'stage', 'root'),
  wslHostPath('/root/.dsh-stage/x86_64'),
  wslHostPath('/root/.dsh-stage/arm64'),
].filter(Boolean)

const snapshotInput = argOf('--snapshot', '')
let piVersion
let catalogs
if (snapshotInput) {
  // Read only the pinned package identity and JSON catalogs. No tar member is extracted
  // and symlinks are never followed, so the build does not execute snapshot code.
  const reader = `import json, sys, tarfile
prefix = sys.argv[2] + '/'
manifest = None
catalogs = []
with tarfile.open(sys.argv[1], 'r|xz') as archive:
    for member in archive:
        if not member.isfile():
            continue
        if member.name == prefix + 'package.json':
            manifest = json.load(archive.extractfile(member))
        elif member.name.startswith(prefix + 'dist/providers/data/') and member.name.endswith('.json'):
            relative = member.name[len(prefix + 'dist/providers/data/'):]
            if '/' not in relative:
                catalogs.append([relative[:-5], json.load(archive.extractfile(member))])
if not manifest or manifest.get('name') != '@earendil-works/pi-ai' or not catalogs:
    raise RuntimeError('snapshot is missing the pi-ai package identity or provider catalogs')
print(json.dumps({'version': manifest['version'], 'catalogs': sorted(catalogs)}))
`
  const captured = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', reader, resolve(snapshotInput), PI_SUBPATH], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 }))
  piVersion = captured.version
  catalogs = captured.catalogs
} else {
  const engineRoot = candidates.find((p) => existsSync(join(p, PI_SUBPATH, 'dist', 'providers', 'data')))
  if (!engineRoot) {
    console.error('找不到 pi-ai 厂商目录。候选位置：\n  ' + candidates.join('\n  '))
    console.error('用 --snapshot 指定已校验快照，或用 --engine-root 指定快照根。')
    process.exit(1)
  }
  const piDir = join(engineRoot, PI_SUBPATH)
  const dataDir = join(piDir, 'dist', 'providers', 'data')
  piVersion = JSON.parse(readFileSync(join(piDir, 'package.json'), 'utf8')).version
  catalogs = readdirSync(dataDir).filter(file => file.endsWith('.json')).sort()
    .map(file => [file.slice(0, -5), JSON.parse(readFileSync(join(dataDir, file), 'utf8'))])
}
const SOURCE_DATE_EPOCH = Number(process.env.SOURCE_DATE_EPOCH ?? 1704067200)
const models = modelCapabilities(catalogs)
const files = catalogs.length
if (Object.keys(models).length === 0) throw new Error('pi-ai catalog contains no usable chat model declarations')

const snapshot = {
  schema: 1,
  source: `@earendil-works/pi-ai@${piVersion} dist/providers/data`,
  engineRootHint: PI_SUBPATH,
  generatedAt: new Date(SOURCE_DATE_EPOCH * 1000).toISOString(),
  modelCount: Object.keys(models).length,
  models,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(snapshot) + '\n')
const kb = Math.round(Buffer.byteLength(JSON.stringify(snapshot)) / 1024)
console.log(`gen-model-catalog: pi-ai ${piVersion} / ${files} 个目录 / ${snapshot.modelCount} 个模型 / ${kb} KB -> ${OUT}`)
