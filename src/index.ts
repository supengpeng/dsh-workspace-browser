/**
 * @dsh-external/workspace-browser — 浏览工作区文件夹的目录结构与文件列表。
 *
 * 注册一个模型可见的 `list_workspace` 工具：
 * - 不传 `path` 时列出当前会话工作区根目录；
 * - 传相对路径时在该工作区内向下浏览；
 * - 传绝对路径时仅当路径位于工作区根之内才允许列出；
 * - `recursive` 开启后递归列出子目录，`max_depth` 限制递归深度；
 * - `include_hidden` 控制是否包含 `.` 开头的隐藏文件/目录。
 *
 * 实现基于 DeepSeek Harness 的 `ctx.fs` 服务（`resolve` + `listDir` + `contains`），
 * 不直接触碰 Node fs，因此远程/沙箱后端同样可用。注册挂在 `ctx.effect` 上，
 * 插件卸载或 HMR 时自动注销。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = '@dsh-external/workspace-browser'
export const inject = ['tools', 'fs', 'webServer']

/** `ctx.fs` 的结构化最小视图（完整契约见 @deepseek-ai/dsh-fs）。 */
interface FsTarget {
  targetKey: string
  displayPath: string
}

interface FsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget
  size?: number
}

interface FsService {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  contains(parent: FsTarget, child: FsTarget): boolean
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  editText(
    target: FsTarget,
    edit: { oldString: string; newString: string; replaceAll: boolean },
    expected?: unknown,
    signal?: AbortSignal,
  ): Promise<{ before: string; after: string }>
}

interface WebServerService {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface SessionHeader {
  cwd?: string
}

interface SessionsService {
  get(id: string): { header: SessionHeader } | undefined
}

type AppContext = Context & { fs: FsService; webServer: WebServerService }

/** 递归收集时的共享状态，用于全局条目上限与目录环检测。 */
interface CollectState {
  remaining: number
  truncated: boolean
  visited: Set<string>
}

/** 返回给模型的单个条目（深度从 0 开始）。 */
interface WorkspaceEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  path: string
  depth: number
  size?: number
}

export interface Config {
  /** 工作区根目录；留空时使用会话 cwd，会话无 cwd 时使用 fs 后端默认 cwd。 */
  root: string
  /** 单次列出的最大条目数；超出后 `truncated` 为 true。 */
  maxEntries: number
  /** `recursive: true` 且未传 `max_depth` 时的默认递归深度。 */
  maxDepth: number
  /** 默认是否包含 `.` 开头的隐藏文件/目录。 */
  showHidden: boolean
  /** 是否允许列出工作区根之外的绝对路径（默认 false）。 */
  allowOutsideRoot: boolean
  /** Web UI 文件预览的字节上限。 */
  maxPreviewBytes: number
}

export const Config = z.object({
  root: z.string().default(''),
  maxEntries: z.natural().min(1).default(1000),
  maxDepth: z.natural().min(0).default(5),
  showHidden: z.boolean().default(false),
  allowOutsideRoot: z.boolean().default(false),
  maxPreviewBytes: z.natural().min(1024).default(1024 * 1024),
})

/** 解析并校验 `max_entries` 参数，不允许超过部署上限。 */
function parseMaxEntries(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('max_entries must be a positive integer')
  }
  if (value > max) {
    throw new Error(`max_entries must be less than or equal to ${max}`)
  }
  return value
}

/** 解析并校验 `max_depth` 参数，不允许超过部署上限。 */
function parseMaxDepth(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('max_depth must be a non-negative integer')
  }
  if (value > max) {
    throw new Error(`max_depth must be less than or equal to ${max}`)
  }
  return value
}

/** 解析 `path` 参数：空字符串和 `.` 都表示工作区根。 */
function parsePath(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' || trimmed === '.' ? '.' : trimmed
}

/** 从执行上下文取会话工作区根；非 agent 调用返回 undefined。 */
function sessionRoot(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}

/** 按 sessionId 读取会话工作区根；会话不存在或无 cwd 时返回 undefined。 */
function sessionCwdById(ctx: AppContext, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  return sessions?.get(sessionId)?.header.cwd
}

/** 解析 HTTP 查询参数中的布尔值。 */
function parseBool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback
  return value === 'true' || value === '1'
}

/** 判断名称是否为隐藏条目（`.` 开头）。 */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** 读取并解析 JSON 请求体（用于写文件等 POST 接口）。 */
async function readJson(req: IncomingMessage, cap = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > cap) throw new Error(`请求体超过上限 ${cap} 字节`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 解析并校验目录列表请求，返回目标 target 与是否发生截断。
 * 供工具执行和 HTTP API 共用。
 */
async function resolveListTarget(
  ctx: AppContext,
  root: string | undefined,
  path: string,
  allowOutsideRoot: boolean,
  signal: AbortSignal,
): Promise<FsTarget> {
  const resolveOptions = {
    ...root !== undefined ? { cwd: root } : {},
    signal,
  }
  const target = await ctx.fs.resolve(path, resolveOptions)

  if (!allowOutsideRoot && root !== undefined) {
    const rootTarget = await ctx.fs.resolve(root, { signal })
    if (!ctx.fs.contains(rootTarget, target)) {
      throw new Error(`path "${target.displayPath}" is outside the workspace root "${rootTarget.displayPath}"`)
    }
  }
  return target
}

/**
 * 递归收集目录条目，返回扁平列表；`depth` 表示相对目标目录的层级。
 * 通过 `visited` 记录已进入的 targetKey，避免符号链接目录造成环。
 */
async function collectEntries(
  ctx: AppContext,
  target: FsTarget,
  depth: number,
  maxDepth: number,
  includeHidden: boolean,
  signal: AbortSignal,
  state: CollectState,
): Promise<WorkspaceEntry[]> {
  const out: WorkspaceEntry[] = []
  if (state.remaining <= 0) {
    state.truncated = true
    return out
  }

  const raw = await ctx.fs.listDir(target, signal)
  for (const entry of raw) {
    if (state.remaining <= 0) {
      state.truncated = true
      break
    }
    if (!includeHidden && isHidden(entry.name)) continue

    out.push({
      name: entry.name,
      type: entry.type,
      path: entry.target.displayPath,
      depth,
      ...entry.size !== undefined ? { size: entry.size } : {},
    })
    state.remaining -= 1

    if (depth < maxDepth && entry.type === 'directory') {
      const key = entry.target.targetKey
      if (!state.visited.has(key)) {
        state.visited.add(key)
        out.push(...await collectEntries(ctx, entry.target, depth + 1, maxDepth, includeHidden, signal, state))
      }
    }
  }
  return out
}

/**
 * 注册 Web UI 使用的目录列表 HTTP API。
 * @param ctx - 插件上下文；`webServer` 已就绪。
 * @param config - 插件配置。
 */
function applyWorkspaceBrowserApi(ctx: AppContext, config: Config): void {
  const API_PREFIX = '/workspace-browser/api'
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname.replace(/^\/workspace-browser\/api/, '') || '/'
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const cwd = sessionId ? sessionCwdById(ctx, sessionId) : undefined
        const root = config.root || cwd

        if (req.method === 'POST' && pathname === '/write') {
          const body = await readJson(req)
          const path = parsePath(String(body.path ?? ''))
          const content = String(body.content ?? '')
          const signal = new AbortController().signal
          const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, signal)
          const info = await ctx.fs.stat(target, signal)
          if (info?.type !== 'file') throw new Error('not a file')
          await ctx.fs.writeText(target, content, undefined, signal)
          return send(200, { ok: true, path: target.displayPath })
        }

        if (req.method !== 'GET') {
          return send(404, { ok: false, error: `not found: ${req.method ?? 'GET'} ${pathname}` })
        }

        if (pathname === '/read') {
          const path = parsePath(url.searchParams.get('path') ?? undefined)
          const signal = new AbortController().signal
          const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, signal)
          const info = await ctx.fs.stat(target, signal)
          if (info?.type !== 'file') throw new Error('not a file')
          if (info.size !== undefined && info.size > config.maxPreviewBytes) {
            throw new Error(`文件过大（${info.size} 字节），超过预览上限 ${config.maxPreviewBytes} 字节`)
          }
          const content = await ctx.fs.readText(target, signal)
          return send(200, { ok: true, path: target.displayPath, content })
        }

        if (pathname !== '/list') {
          return send(404, { ok: false, error: `not found: ${req.method ?? 'GET'} ${pathname}` })
        }

        const path = parsePath(url.searchParams.get('path') ?? undefined)
        const rawMaxEntries = url.searchParams.get('max_entries')
        const maxEntries = rawMaxEntries === null
          ? config.maxEntries
          : parseMaxEntries(Number(rawMaxEntries), config.maxEntries, config.maxEntries)
        const recursive = parseBool(url.searchParams.get('recursive'), false)
        const rawMaxDepth = url.searchParams.get('max_depth')
        const maxDepth = recursive
          ? rawMaxDepth === null
            ? config.maxDepth
            : parseMaxDepth(Number(rawMaxDepth), config.maxDepth, config.maxDepth)
          : 0
        const includeHidden = parseBool(url.searchParams.get('include_hidden'), config.showHidden)
        const signal = new AbortController().signal

        const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, signal)
        const state: CollectState = {
          remaining: maxEntries,
          truncated: false,
          visited: new Set([target.targetKey]),
        }
        const entries = await collectEntries(
          ctx,
          target,
          0,
          maxDepth,
          includeHidden,
          signal,
          state,
        )
        return send(200, {
          ok: true,
          cwd: root ?? null,
          path: target.displayPath,
          entries,
          truncated: state.truncated,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return send(400, { ok: false, error: message })
      }
    },
  }), '@dsh-external/workspace-browser: api')
}

/**
 * 注册 `list_workspace` 工具。
 * @param ctx - 插件上下文；`tools` 与 `fs` 已就绪。
 * @param config - 插件配置（schemastery 已填默认值）。
 */
export function apply(ctx: AppContext, config: Config): void {
  applyWorkspaceBrowserApi(ctx, config)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_workspace',
    description: 'List directories and files in the current workspace. Omit path to list the workspace root; pass a relative path to browse into a subdirectory. Use recursive to include nested directories and include_hidden to show dotfiles.',
    parameters: {
      path: { type: 'string', description: 'Directory to list, relative to the workspace root. Defaults to the workspace root.' },
      max_entries: { type: 'number', description: `Maximum entries to return. Defaults to ${config.maxEntries}.` },
      recursive: { type: 'boolean', description: 'Whether to recursively list nested directories. Defaults to false.' },
      max_depth: { type: 'number', description: `Maximum recursion depth when recursive is true. Defaults to ${config.maxDepth}.` },
      include_hidden: { type: 'boolean', description: `Whether to include hidden files and directories (names starting with .). Defaults to ${config.showHidden}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
                path: { type: 'string', required: true },
                depth: { type: 'integer', required: true },
                size: { type: 'integer' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = value.entries.map((entry: WorkspaceEntry) => {
          const indent = '  '.repeat(entry.depth)
          const suffix = entry.type === 'directory' ? '/' : entry.size !== undefined ? ` (${entry.size} bytes)` : ''
          return `${indent}${entry.name}${suffix}`
        })
        const body = lines.length > 0 ? lines.join('\n') : '(empty directory)'
        return [{
          type: 'text',
          text: `<path>${value.path}</path>\n<type>directory</type>\n<content>\n${body}\n</content>`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = parsePath(args.path)
      const maxEntries = parseMaxEntries(args.max_entries, config.maxEntries, config.maxEntries)
      const maxDepth = args.recursive
        ? parseMaxDepth(args.max_depth, config.maxDepth, config.maxDepth)
        : 0
      const includeHidden = args.include_hidden ?? config.showHidden
      const cwd = sessionRoot(exec)
      const root = config.root || cwd
      const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, exec.signal)

      const state: CollectState = {
        remaining: maxEntries,
        truncated: false,
        visited: new Set([target.targetKey]),
      }
      const entries = await collectEntries(
        ctx,
        target,
        0,
        maxDepth,
        includeHidden,
        exec.signal,
        state,
      )
      return {
        path: target.displayPath,
        entries,
        truncated: state.truncated,
      }
    },
    presentCall(args): { card: 'generic'; title: string; kind: 'search'; locations: { path: string }[] } {
      const path = parsePath(args.path)
      const mode = args.recursive ? 'recursive' : 'direct'
      return {
        card: 'generic',
        title: `List ${path === '.' ? 'workspace root' : path} (${mode})`,
        kind: 'search',
        locations: [{ path }],
      }
    },
  })), '@dsh-external/workspace-browser: list_workspace')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_workspace_file',
    description: 'Read a UTF-8 text file from the current workspace. Fails when the file is larger than the configured preview limit.',
    parameters: {
      path: { type: 'string', description: 'File path relative to the workspace root, or an absolute path inside the workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          size: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<size>${value.size}</size>\n<content>\n${value.content}\n</content>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = parsePath(args.path)
      const root = config.root || sessionRoot(exec)
      const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, exec.signal)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info?.type !== 'file') throw new Error('not a file')
      if (info.size !== undefined && info.size > config.maxPreviewBytes) {
        throw new Error(`file too large (${info.size} bytes > ${config.maxPreviewBytes})`)
      }
      const content = await ctx.fs.readText(target, exec.signal)
      return { path: target.displayPath, content, size: info.size ?? content.length }
    },
    presentCall(args): { card: 'generic'; title: string; kind: 'read'; locations: { path: string }[] } {
      const path = parsePath(args.path)
      return { card: 'generic', title: `Read ${path}`, kind: 'read', locations: [{ path }] }
    },
  })), '@dsh-external/workspace-browser: read_workspace_file')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'write_workspace_file',
    description: 'Create or overwrite a UTF-8 text file in the current workspace. The file path must stay inside the workspace root.',
    parameters: {
      path: { type: 'string', description: 'File path relative to the workspace root, or an absolute path inside the workspace.' },
      content: { type: 'string', description: 'Full new file content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<operation>${value.operation}</operation>\n<ok>${value.ok}</ok>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = parsePath(args.path)
      const root = config.root || sessionRoot(exec)
      const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, exec.signal)
      const info = await ctx.fs.stat(target, exec.signal)
      const operation: 'create' | 'update' = info ? 'update' : 'create'
      await ctx.fs.writeText(target, args.content ?? '', undefined, exec.signal)
      return { ok: true, path: target.displayPath, operation }
    },
    presentCall(args): { card: 'generic'; title: string; kind: 'edit'; locations: { path: string }[] } {
      const path = parsePath(args.path)
      return { card: 'generic', title: `Write ${path}`, kind: 'edit', locations: [{ path }] }
    },
  })), '@dsh-external/workspace-browser: write_workspace_file')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'edit_workspace_file',
    description: 'Apply a literal text edit to a file in the current workspace. Use replace_all to replace every occurrence; otherwise exactly one match is required.',
    parameters: {
      path: { type: 'string', description: 'File path relative to the workspace root, or an absolute path inside the workspace.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Replacement text. Empty string deletes the matched text.' },
      replace_all: { type: 'boolean', description: 'Replace every match instead of requiring exactly one. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<changed>${value.changed}</changed>\n<ok>${value.ok}</ok>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = parsePath(args.path)
      const root = config.root || sessionRoot(exec)
      const target = await resolveListTarget(ctx, root, path, config.allowOutsideRoot, exec.signal)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info?.type !== 'file') throw new Error('not a file')
      if (info.size !== undefined && info.size > config.maxPreviewBytes) {
        throw new Error(`file too large (${info.size} bytes > ${config.maxPreviewBytes})`)
      }
      const result = await ctx.fs.editText(target, {
        oldString: args.old_string ?? '',
        newString: args.new_string ?? '',
        replaceAll: args.replace_all ?? false,
      }, undefined, exec.signal)
      return { ok: true, path: target.displayPath, changed: result.before !== result.after }
    },
    presentCall(args): { card: 'generic'; title: string; kind: 'edit'; locations: { path: string }[] } {
      const path = parsePath(args.path)
      return { card: 'generic', title: `Edit ${path}`, kind: 'edit', locations: [{ path }] }
    },
  })), '@dsh-external/workspace-browser: edit_workspace_file')
}
