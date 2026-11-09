// Real archive -> browser overlay -> one-pass injector -> unchanged final scan.
// These fixtures use preset 1 only to keep the tests small and fast.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHECKER = join(ROOT, 'scripts/check-browser-syntax-floor.mjs')
const INJECTOR = join(ROOT, 'scripts/inject-all.py')
const PYTHON = process.env.PYTHON || 'python'
const ENGINE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
const FRONT = ENGINE + '/@deepseek-ai/dsh-web-frontend/dist/index-fixture.js'
const CLIENT = ENGINE + '/dsh-client-overlay-fixture/lib/client.js'
const CLIENT_SYMLINK = ENGINE + '/dsh-client-overlay-link/lib/client.js'
const CLIENT_HARDLINK = ENGINE + '/dsh-client-overlay-hardlink/lib/client.js'
const HOME_CLIENT = 'home/.dsh/profiles/web/node_modules/overlay-demo/lib/client.js'
const SHARED_LINK = 'home/.dsh/profiles/node_modules/undici'
const FIXED_MTIME = 1704067200
const scratch = mkdtempSync(join(tmpdir(), 'dsh-browser-overlay-test-'))
const archive = join(scratch, 'source.tar.xz')
const overlay = join(scratch, 'overlay')
const patch = join(scratch, 'factory.patch.yml')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts/patches/registry.json'), 'utf8'))
const markers = registry.patches.map((entry) => entry.marker)
  .filter((marker) => typeof marker === 'string' && /^[A-Za-z][A-Za-z0-9 _().:-]{5,100}$/.test(marker))
assert.ok(markers.length >= 2, 'the fixture needs two real, single-line patch markers')
const presentMarker = markers[0]
const absentMarker = markers.find((marker) => !presentMarker.includes(marker) && !marker.includes(presentMarker))
assert.ok(absentMarker, 'the marker non-forgery control needs a distinct registered marker')

const frontSource = 'class Counter { static { this.value = 9 } }\n'
  + 'export const actual = Counter.value + ({ nested: { value: 33 } }?.nested?.value ?? 0)\n'
const clientSource = '// ' + presentMarker + '\n'
  + 'window.__ModuleLoader__.load({ id: "overlay-fixture", factory: (require) => {\n'
  + '  const dep = require("fixture-dependency"); return { actual: dep?.nested?.value ?? 0 };\n'
  + '} });\n'
const oldHomeClient = 'window.__ModuleLoader__.load({ id: "overlay-demo", factory: (require) => {\n'
  + '  class Old { static { this.value = 1 } } return { actual: Old.value };\n'
  + '} });\n'
const newHomeClient = 'window.__ModuleLoader__.load({ id: "overlay-demo", factory: (require) => ({ actual: 2 }) });\n'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.notEqual(result.status, null, 'subprocess must finish normally: ' + command)
  return result
}

function ok(result, label) {
  assert.equal(result.status, 0, label + '\n' + result.stdout + '\n' + result.stderr)
  return result
}

function checker(args) { return run(process.execPath, [CHECKER, ...args]) }

function inject(name, overlayDir = overlay, external = null) {
  const output = join(scratch, name + '.tar.xz')
  const args = [INJECTOR, archive, output, patch, '--browser-overlay', overlayDir]
  if (external) args.push('--external', external)
  return { output, result: run(PYTHON, args, { env: { ...process.env, DSH_INJECT_PRESET: '1' } }) }
}

function readArchive(path) {
  return JSON.parse(ok(run(PYTHON, ['-c', String.raw`
import base64,json,sys,tarfile
out={}
with tarfile.open(sys.argv[1], 'r:*') as archive:
    for member in archive:
        entry={key:getattr(member,key) for key in ['name','mode','mtime','uid','gid','uname','gname','linkname']}
        entry['type']=member.type.decode('ascii')
        if member.isfile(): entry['bytes']=base64.b64encode(archive.extractfile(member).read()).decode('ascii')
        if member.name in out: raise ValueError('duplicate archive member: '+member.name)
        out[member.name]=entry
print(json.dumps(out))
`, path]), 'read test archive').stdout)
}

function textOf(members, path) { return Buffer.from(members[path].bytes, 'base64').toString('utf8') }

function loadClient(code) {
  let loaded
  runInNewContext(code, { window: { __ModuleLoader__: { load(value) { loaded = value } } } }, { timeout: 1000 })
  assert.equal(typeof loaded?.factory, 'function')
  // The browser loader's CJS wrapper must retain its require parameter, without
  // an ESM-format conversion introducing require2 or changing the wrapper shape.
  assert.match(loaded.factory.toString(), /^(?:\(\s*require\s*\)|require)\s*=>/)
  return loaded.factory((id) => {
    assert.equal(id, 'fixture-dependency')
    return { nested: { value: 42 } }
  }).actual
}

let sourceMembers
let manifest
before(() => {
  writeFileSync(patch, '- insert:\n    - id: demo\n      name: overlay-demo\n')
  const entries = [
    { name: FRONT, data: frontSource },
    { name: CLIENT, data: clientSource },
    { name: HOME_CLIENT, data: oldHomeClient },
    { name: 'home/.dsh/profiles/web/node_modules/overlay-demo/package.json', data: '{"name":"overlay-demo","version":"1.0.0"}\n' },
    { name: 'home/.dsh/profiles/web/cordis.patch.yml', data: '[]\n' },
    { name: 'home/.dsh/profiles/headless/cordis.patch.yml', data: '[]\n' },
    { name: ENGINE + '/@deepseek-ai/dsh-app-boot/lib/index.js', data: 'const DSH_MOBILE_ASSEMBLED_MANIFEST = {"names":["fixture"],"complete":true};\n' },
    { name: 'home/.dsh/fixture-data.txt', data: 'unchanged non-browser data\n' },
    { name: CLIENT_SYMLINK, kind: 'symlink', linkname: '../../dsh-client-overlay-fixture/lib/client.js' },
    { name: CLIENT_HARDLINK, kind: 'hardlink', linkname: CLIENT },
    { name: SHARED_LINK, kind: 'symlink', linkname: '../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici' },
  ]
  ok(run(PYTHON, ['-c', String.raw`
import io,json,sys,tarfile
entries=json.load(sys.stdin)
seen=set()
with tarfile.open(sys.argv[1], 'w:xz', preset=1, format=tarfile.PAX_FORMAT) as archive:
    for entry in entries:
        parts=entry['name'].split('/')
        for i in range(1,len(parts)):
            parent='/'.join(parts[:i])
            if parent in seen: continue
            seen.add(parent)
            directory=tarfile.TarInfo(parent); directory.type=tarfile.DIRTYPE
            directory.mode=0o700; directory.mtime=1704067200
            archive.addfile(directory)
        member=tarfile.TarInfo(entry['name']); member.mtime=1704067200
        member.uid=123; member.gid=456; member.uname='fixture-user'; member.gname='fixture-group'
        if entry.get('kind') in ['symlink','hardlink']:
            member.type=tarfile.SYMTYPE if entry['kind']=='symlink' else tarfile.LNKTYPE
            member.linkname=entry['linkname']; member.mode=0o777
            archive.addfile(member)
        else:
            data=entry['data'].encode(); member.size=len(data); member.mode=0o600
            archive.addfile(member,io.BytesIO(data))
`, archive], { input: JSON.stringify(entries) }), 'create tiny tar fixture')
  sourceMembers = readArchive(archive)
  const reverse = checker(['--scan', archive])
  assert.equal(reverse.status, 1, 'the undegraded source must be rejected for syntax, not missing tools\n' + reverse.stdout + reverse.stderr)
  assert.match(reverse.stdout, /VIOLATION-STATIC/)
  ok(checker(['--degrade', '--archive', archive, '--overlay', overlay]), 'generate browser overlay')
  manifest = JSON.parse(readFileSync(join(overlay, 'browser-overlay.json'), 'utf8'))
})

after(() => rmSync(scratch, { recursive: true, force: true }))

test('real archive overlay passes the final full scan, preserves behavior, markers and links', async () => {
  assert.equal(manifest.version, 1)
  assert.equal(manifest.target, 'chrome87')
  assert.equal(manifest.esbuildVersion, '0.25.12')
  assert.equal(manifest.archiveSha256, sha256(readFileSync(archive)))
  for (const path of [FRONT, CLIENT, HOME_CLIENT]) {
    const row = manifest.files.find((entry) => entry.path === path)
    assert.ok(row, 'regular browser target must be present: ' + path)
    assert.equal(row.sourceSha256, sha256(Buffer.from(sourceMembers[path].bytes, 'base64')))
    assert.equal(row.outputSha256, sha256(readFileSync(join(overlay, 'files', path))))
  }
  for (const path of [CLIENT_SYMLINK, CLIENT_HARDLINK, SHARED_LINK]) {
    assert.ok(!manifest.files.some((entry) => entry.path === path), 'links must not become overlay regular files')
  }
  const { output, result } = inject('final')
  ok(result, 'inject overlay in one archive pass')
  const forward = ok(checker(['--scan', output]), 'scan the actual final archive')
  assert.match(forward.stdout, /BROWSER-SYNTAX-FLOOR PASS/)
  assert.match(forward.stdout, /判据2 差分: 0\//)
  const final = readArchive(output)
  const client = textOf(final, CLIENT)
  assert.ok(client.includes(presentMarker), 'an existing patch marker must survive esbuild comment removal')
  assert.ok(!client.includes(absentMarker), 'the overlay must not invent other patch markers')
  assert.ok(!textOf(final, FRONT).includes(presentMarker), 'a marker belongs only to the original member')
  assert.equal(loadClient(clientSource), 42)
  assert.equal(loadClient(client), 42)
  const originalModule = await import('data:text/javascript;base64,' + Buffer.from(frontSource).toString('base64'))
  const finalModule = await import('data:text/javascript;base64,' + Buffer.from(textOf(final, FRONT)).toString('base64'))
  assert.equal(originalModule.actual, 42)
  assert.equal(finalModule.actual, originalModule.actual)
  for (const path of [CLIENT_SYMLINK, CLIENT_HARDLINK, SHARED_LINK]) assert.deepEqual(final[path], sourceMembers[path])
  for (const path of [FRONT, CLIENT, HOME_CLIENT]) {
    assert.equal(final[path].mode, 0o600)
    assert.equal(final[path].mtime, FIXED_MTIME)
  }
  assert.equal(textOf(final, 'home/.dsh/fixture-data.txt'), 'unchanged non-browser data\n')
})

test('local external client wins over the old archive overlay in both assembly profiles', () => {
  const external = join(scratch, 'external')
  mkdirSync(join(external, 'lib'), { recursive: true })
  writeFileSync(join(external, 'package.json'), '{"name":"overlay-demo","version":"2.0.0"}\n')
  writeFileSync(join(external, 'lib/client.js'), newHomeClient)
  const { output, result } = inject('local-wins', overlay, external)
  ok(result, 'inject local plugin and browser overlay together')
  const final = readArchive(output)
  assert.equal(textOf(final, HOME_CLIENT), newHomeClient)
  assert.equal(textOf(final, HOME_CLIENT.replace('/web/', '/headless/')), newHomeClient)
  assert.equal(loadClient(textOf(final, HOME_CLIENT)), 2)
  ok(checker(['--scan', output]), 'local override still satisfies the final full scan')
})

test('invalid overlays are rejected by the actual injector before an output is accepted', async (t) => {
  const cases = [
    ['wrong source archive', (doc) => { doc.archiveSha256 = '0'.repeat(64) }],
    ['wrong source member digest', (doc) => { doc.files[0].sourceSha256 = '0'.repeat(64) }],
    ['duplicate member path', (doc) => { doc.files.push({ ...doc.files[0] }) }],
    ['tampered output bytes', (doc, dir) => {
      writeFileSync(join(dir, 'files', doc.files[0].path), 'export const tampered = true\n')
    }],
    ['unknown archive target', (doc, dir) => {
      addTarget(doc, dir, ENGINE + '/dsh-client-missing/lib/client.js')
    }],
    ['non-browser target', (doc, dir) => {
      addTarget(doc, dir, 'home/.dsh/fixture-data.txt')
    }],
    ['symbolic-link archive target', (doc, dir) => { addTarget(doc, dir, CLIENT_SYMLINK) }],
    ['hard-link archive target', (doc, dir) => { addTarget(doc, dir, CLIENT_HARDLINK) }],
    ['symbolic-link overlay payload', (doc, dir) => {
      const payload = join(dir, 'files', doc.files[0].path)
      rmSync(payload)
      symlinkSync(join(overlay, 'files', doc.files[0].path), payload)
    }],
  ]
  for (let index = 0; index < cases.length; index++) {
    const [label, mutate] = cases[index]
    await t.test(label, () => {
      const dir = join(scratch, 'negative-' + index)
      cpSync(overlay, dir, { recursive: true })
      const doc = JSON.parse(readFileSync(join(dir, 'browser-overlay.json'), 'utf8'))
      mutate(doc, dir)
      writeFileSync(join(dir, 'browser-overlay.json'), JSON.stringify(doc))
      const { result } = inject('rejected-' + index, dir)
      assert.notEqual(result.status, 0, 'invalid overlay must not be accepted: ' + label)
      assert.match(result.stdout + result.stderr, /overlay|浏览器/i, 'rejection must identify the overlay')
    })
  }
})

function addTarget(doc, dir, path) {
  const original = doc.files.find((entry) => entry.path === CLIENT)
  const payload = readFileSync(join(dir, 'files', original.path))
  const target = join(dir, 'files', path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, payload)
  doc.files.push({ ...original, path })
}
