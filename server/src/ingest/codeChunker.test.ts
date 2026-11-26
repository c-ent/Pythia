import { describe, expect, it } from 'vitest'
import { chunkCode, MAX_CHUNK_CHARS, MAX_SYMBOL_LINES, WINDOW_LINES, type CodeChunk } from './codeChunker.js'

const heads = (chunks: CodeChunk[]): Array<[string, number, number]> =>
  chunks.map((chunk) => [chunk.headingPath, chunk.startLine, chunk.endLine])

const chunk = (path: string, language: string | null, content: string) =>
  chunkCode({ repo: 'kitchen', path, language, content })

describe('chunkCode with tree-sitter', () => {
  it('splits TypeScript at functions and classes and keeps doc comments with them', async () => {
    const source = [
      "import { x } from './x'", //                          1
      '', //                                                  2
      '/** Adds two numbers. */', //                          3
      'export function add(a: number, b: number) {', //       4
      '  return a + b', //                                    5
      '}', //                                                 6
      '', //                                                  7
      'export class Cart {', //                               8
      '  items: string[] = []', //                            9
      '  add(item: string) {', //                            10
      '    this.items.push(item)', //                        11
      '  }', //                                              12
      '}', //                                                13
      '', //                                                 14
      'export const total = (n: number) => n * 2', //       15
      'type Id = string', //                                 16
      '',
    ].join('\n')
    const result = await chunk('src/cart.ts', 'typescript', source)
    expect(result.method).toBe('tree-sitter')
    expect(heads(result.chunks)).toEqual([
      ['src/cart.ts > add', 1, 6],
      ['src/cart.ts > Cart', 8, 13],
      ['src/cart.ts > total, Id', 15, 16],
    ])
    expect(result.chunks[0]?.content).toContain('/** Adds two numbers. */')
    expect(result.chunks.map((c) => c.ordinal)).toEqual([0, 1, 2])
    expect(result.chunks[1]?.embedText).toBe(`kitchen > src/cart.ts > Cart\n\n${result.chunks[1]?.content}`)
  })

  it('splits a class that is too big into its methods', async () => {
    const body = (name: string) => [`  ${name}() {`, ...Array.from({ length: 50 }, (_, i) => `    step${i}()`), '  }']
    const source = ['export class Big {', ...body('first'), ...body('second'), ...body('third'), '}', ''].join('\n')
    const result = await chunk('src/big.ts', 'typescript', source)
    expect(result.method).toBe('tree-sitter')
    expect(result.chunks.map((c) => c.headingPath)).toEqual([
      'src/big.ts > Big > first',
      'src/big.ts > Big > second',
      'src/big.ts > Big > third',
    ])
    expect(result.chunks[0]?.startLine).toBe(1)
  })

  it('splits one huge function into numbered windows', async () => {
    const lines = Array.from({ length: MAX_SYMBOL_LINES + 60 }, (_, i) => `  call${i}()`)
    const source = ['function huge() {', ...lines, '}', ''].join('\n')
    const result = await chunk('src/huge.js', 'javascript', source)
    expect(result.chunks.map((c) => c.headingPath)).toEqual([
      'src/huge.js > huge (part 1 of 3)',
      'src/huge.js > huge (part 2 of 3)',
      'src/huge.js > huge (part 3 of 3)',
    ])
    for (const c of result.chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(WINDOW_LINES)
  })

  it('handles JavaScript function expressions and CommonJS exports', async () => {
    const source = [
      "const fs = require('fs')",
      '',
      'function readConfig(file) {',
      "  return JSON.parse(fs.readFileSync(file, 'utf8'))",
      '}',
      '',
      'const writeConfig = function (file, value) {',
      '  fs.writeFileSync(file, JSON.stringify(value))',
      '}',
      '',
      'module.exports = { readConfig, writeConfig }',
      '',
    ].join('\n')
    const result = await chunk('lib/config.js', 'javascript', source)
    expect(result.method).toBe('tree-sitter')
    expect(heads(result.chunks)).toEqual([
      ['lib/config.js > readConfig', 1, 5],
      ['lib/config.js > writeConfig', 7, 9],
      ['lib/config.js', 11, 11],
    ])
  })

  it('splits Python at decorated functions and classes', async () => {
    const source = [
      'import os',
      '',
      '',
      '@cache',
      'def load(path):',
      '    """Reads a file."""',
      '    with open(path) as handle:',
      '        return handle.read()',
      '',
      '',
      'class Store:',
      '    def get(self, key):',
      '        return os.environ.get(key)',
      '',
      '    def put(self, key, value):',
      '        os.environ[key] = value',
      '',
    ].join('\n')
    const result = await chunk('app/store.py', 'python', source)
    expect(result.method).toBe('tree-sitter')
    expect(heads(result.chunks)).toEqual([
      ['app/store.py > load', 1, 8],
      ['app/store.py > Store', 11, 16],
    ])
    expect(result.chunks[0]?.content).toContain('@cache')
  })

  it('splits PHP at classes and functions', async () => {
    const source = [
      '<?php',
      'namespace App\\Models;',
      '',
      '/**',
      ' * A user of the shop.',
      ' */',
      'class User',
      '{',
      '    public function name(): string',
      '    {',
      "        return 'x';",
      '    }',
      '}',
      '',
      'function helper(): int',
      '{',
      '    return 1;',
      '}',
      '',
    ].join('\n')
    const result = await chunk('src/User.php', 'php', source)
    expect(result.method).toBe('tree-sitter')
    const names = result.chunks.map((c) => c.headingPath)
    expect(names).toContain('src/User.php > User')
    expect(names).toContain('src/User.php > helper')
    const user = result.chunks.find((c) => c.headingPath === 'src/User.php > User')
    expect(user?.content).toContain('A user of the shop.')
    expect(user?.endLine).toBe(13)
  })

  it('reports 1-based line numbers that match the content, with CRLF input', async () => {
    const source = 'export function a() {\r\n  return 1\r\n}\r\n\r\nexport function b() {\r\n  return 2\r\n}\r\n'
    const result = await chunk('src/crlf.ts', 'typescript', source)
    for (const c of result.chunks) {
      const lines = source.replace(/\r\n/g, '\n').split('\n').slice(c.startLine - 1, c.endLine)
      expect(c.content).toBe(lines.join('\n'))
      expect(c.content).not.toContain('\r')
    }
  })

  it('still chunks a file with syntax errors', async () => {
    const result = await chunk('src/broken.ts', 'typescript', 'export function ok() {\n  return 1\n}\n\nfunction broken( {\n')
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks.map((c) => c.content).join('\n')).toContain('function broken(')
  })
})

describe('chunkCode fallback', () => {
  it('uses 80-line windows for languages without a grammar', async () => {
    const source = Array.from({ length: 200 }, (_, i) => `(define x${i} ${i})`).join('\n')
    const result = await chunk('src/main.clj', 'clojure', source)
    expect(result.method).toBe('lines')
    expect(heads(result.chunks)).toEqual([
      ['src/main.clj', 1, 80],
      ['src/main.clj', 81, 160],
      ['src/main.clj', 161, 200],
    ])
  })

  it('uses windows when the language is unknown', async () => {
    const result = await chunk('Makefile', null, 'all:\n\techo hi\n')
    expect(result).toEqual({
      method: 'lines',
      chunks: [
        {
          ordinal: 0,
          headingPath: 'Makefile',
          startLine: 1,
          endLine: 2,
          content: 'all:\n\techo hi',
          embedText: 'kitchen > Makefile\n\nall:\n\techo hi',
        },
      ],
    })
  })

  it('caps chunk size for files with very long lines', async () => {
    const source = Array.from({ length: 10 }, () => 'x'.repeat(3000)).join('\n')
    const result = await chunk('data/blob.txt', null, source)
    expect(result.chunks.length).toBeGreaterThan(1)
    for (const c of result.chunks) expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
  })

  it('returns no chunks for an empty or blank file', async () => {
    expect((await chunk('src/empty.ts', 'typescript', '')).chunks).toEqual([])
    expect((await chunk('src/blank.py', 'python', '\n\n  \n')).chunks).toEqual([])
  })

  it('is deterministic', async () => {
    const source = 'export function a() {}\nexport function b() {}\n'
    expect(await chunk('src/x.ts', 'typescript', source)).toEqual(await chunk('src/x.ts', 'typescript', source))
  })
})
