/**
 * @dsh-external/workspace-browser — Web UI 半。
 *
 * 直接占用 AppFrame 的右侧 `details` 栏（右 sidebar），显示当前会话工作区
 * 根目录；点击目录继续向下浏览，提供“返回根目录”按钮。
 * 样式使用 Web UI 主题令牌，并针对窄屏/手机端做紧凑适配。
 * 数据来自宿主 HTTP API `/workspace-browser/api/list`。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Button, CodeBlock, IconCloseOutline16, IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

export const inject = ['slots', 'layout']

/** slots 服务的结构化视图。 */
interface SlotsFace {
  inject(key: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** layout 服务的结构化视图（完整契约见 @deepseek-ai/dsh-client-ui-layout）。 */
interface LayoutFace {
  toggleSidebar(): void
  openDetails(): void
  closeDetails(): void
}

type ClientContext = {
  slots: SlotsFace
  layout: LayoutFace
  effect(callback: () => unknown, label?: string): unknown
}

/** useSessions 返回状态的最小视图（完整类型见 @deepseek-ai/dsh-client-runtime/client）。 */
interface SessionSummary {
  id: string
  cwd?: string
}

interface SessionListState {
  current?: string
  byId: Record<string, SessionSummary>
}

type UseSessions = <T>(selector: (state: SessionListState) => T) => T

interface WorkspaceFileBrowserProps {
  useSessions: UseSessions
  onOpenFile?: (path: string, name: string) => void
}

interface WorkspaceEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  path: string
  depth: number
  size?: number
}

interface ListResponse {
  ok: boolean
  cwd?: string | null
  path?: string
  entries?: WorkspaceEntry[]
  error?: string
}

interface ReadResponse {
  ok: boolean
  path?: string
  content?: string
  error?: string
}

interface OpenFile {
  path: string
  name: string
  content: string
  error?: string
}

const API = '/workspace-browser/api'

const fmtBytes = (size: number): string =>
  size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024 ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`

/** 文件类型展示样式：不同扩展名使用不同颜色/标记。 */
interface FileKind {
  label: string
  color: string
  background: string
}

function fileKind(name: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return { label: 'TS', color: '#fff', background: '#3178c6' }
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return { label: 'JS', color: '#1f2d3d', background: '#f7df1e' }
    case 'json':
      return { label: '{}', color: '#fff', background: '#c98a3d' }
    case 'md': case 'markdown':
      return { label: 'MD', color: '#1f2d3d', background: '#d4d4d8' }
    case 'py':
      return { label: 'PY', color: '#fff', background: '#3572A5' }
    case 'css': case 'scss': case 'less':
      return { label: 'CSS', color: '#fff', background: '#663399' }
    case 'html': case 'htm':
      return { label: 'HTML', color: '#fff', background: '#e34c26' }
    case 'yaml': case 'yml':
      return { label: 'YML', color: '#fff', background: '#cb171e' }
    case 'sh': case 'bash': case 'zsh':
      return { label: 'SH', color: '#fff', background: '#4eaa25' }
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico':
      return { label: 'IMG', color: '#fff', background: '#c9518f' }
    case 'zip': case 'tar': case 'gz': case '7z': case 'rar':
      return { label: 'ZIP', color: '#fff', background: '#8b5a2b' }
    case 'exe': case 'bin': case 'dll':
      return { label: 'BIN', color: '#fff', background: '#6b7280' }
    case 'lock':
      return { label: 'LOCK', color: '#fff', background: '#b45309' }
    default:
      return { label: 'FILE', color: '#d1d5db', background: '#374151' }
  }
}

/** 从文件名推断 CodeBlock 使用的语言标识。 */
function langFromName(name: string): string | undefined {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return 'ts'
    case 'tsx': return 'tsx'
    case 'js': case 'mjs': case 'cjs': return 'js'
    case 'jsx': return 'jsx'
    case 'json': return 'json'
    case 'md': case 'markdown': return 'md'
    case 'py': return 'py'
    case 'css': return 'css'
    case 'scss': case 'less': return 'scss'
    case 'html': case 'htm': return 'html'
    case 'yaml': case 'yml': return 'yaml'
    case 'sh': case 'bash': case 'zsh': return 'sh'
    case 'xml': return 'xml'
    case 'sql': return 'sql'
    case 'toml': return 'toml'
    case 'ini': case 'conf': return 'ini'
    default: return undefined
  }
}

function WorkspaceFileBrowser({ useSessions, onOpenFile }: WorkspaceFileBrowserProps): React.ReactElement {
  const list = useSessions(state => state)
  const sessionId = list.current
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (path?: string): Promise<void> => {
    if (sessionId === undefined) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ sessionId })
      if (path !== undefined) params.set('path', path)
      const response = await fetch(`${API}/list?${params.toString()}`)
      const data = await response.json() as ListResponse
      if (!data.ok || data.path === undefined) {
        throw new Error(data.error ?? '加载失败')
      }
      setRootPath(previous => previous ?? data.cwd ?? data.path ?? null)
      setCurrentPath(data.path)
      setEntries(data.entries ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setRootPath(null)
    setCurrentPath(null)
    setEntries([])
    void load()
  }, [load])

  if (sessionId === undefined) {
    return <div className="dsh-wb-empty">当前没有会话</div>
  }

  return (
    <>
      <div className="dsh-wb-pathbar">
        <span className="dsh-wb-path">{currentPath ?? '加载中…'}</span>
        {rootPath !== null && currentPath !== null && currentPath !== rootPath && (
          <Button variant="ghost" size="sm" onClick={() => void load(rootPath)}>⬆ 根目录</Button>
        )}
        {loading && <span className="dsh-wb-loading">加载中…</span>}
      </div>

      {error !== '' && <div className="dsh-wb-error">{error}</div>}
      {entries.length === 0 && !loading && error === '' && (
        <div className="dsh-wb-empty">空目录</div>
      )}

      {entries.map(entry => (
        <div key={entry.path}>
          {entry.type === 'directory' ? (
            <button
              type="button"
              className="dsh-wb-row"
              onClick={() => void load(entry.path)}
            >
              <IconFolderOpenOutline16 className="dsh-wb-folder-icon" />
              <span className="dsh-wb-name">{entry.name}/</span>
            </button>
          ) : (
            <button
              type="button"
              className="dsh-wb-row dsh-wb-row-file"
              onClick={() => onOpenFile?.(entry.path, entry.name)}
            >
              <span
                className="dsh-wb-badge"
                style={{
                  color: fileKind(entry.name).color,
                  background: fileKind(entry.name).background,
                }}
              >
                {fileKind(entry.name).label}
              </span>
              <span className="dsh-wb-name">{entry.name}</span>
              {entry.size !== undefined && (
                <span className="dsh-wb-size">{fmtBytes(entry.size)}</span>
              )}
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/** details 栏（右侧栏）条目收到的 props。 */
interface DetailsProps {
  sessionId: string
  useSessions: UseSessions
}

function WorkspaceDetailsPanel(ctx: ClientContext, props: DetailsProps): React.ReactElement {
  // 桌面端挂载时自动打开右侧栏；手机端为避免与左侧抽屉冲突，改为由入口按钮打开。
  useEffect(() => {
    if (!window.matchMedia('(max-width: 768px)').matches) {
      ctx.layout.openDetails()
    }
  }, [ctx.layout])

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [showBrowser, setShowBrowser] = useState(true)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  const openFile = useCallback(async (path: string, name: string): Promise<void> => {
    if (openFiles.some(file => file.path === path)) {
      setActivePath(path)
      setShowBrowser(false)
      return
    }
    setLoadingPath(path)
    try {
      const params = new URLSearchParams({ sessionId: props.sessionId, path })
      const response = await fetch(`${API}/read?${params.toString()}`)
      const data = await response.json() as ReadResponse
      if (!data.ok || data.content === undefined) throw new Error(data.error ?? '读取失败')
      const file: OpenFile = { path, name, content: data.content }
      setOpenFiles(previous => [...previous, file])
      setActivePath(path)
      setShowBrowser(false)
    } catch (readError) {
      const file: OpenFile = {
        path,
        name,
        content: '',
        error: readError instanceof Error ? readError.message : String(readError),
      }
      setOpenFiles(previous => [...previous, file])
      setActivePath(path)
      setShowBrowser(false)
    } finally {
      setLoadingPath(null)
    }
  }, [openFiles, props.sessionId])

  const closeFile = useCallback((path: string): void => {
    const next = openFiles.filter(file => file.path !== path)
    setOpenFiles(next)
    if (activePath === path) {
      const last = next.at(-1)
      setActivePath(last?.path ?? null)
      if (last === undefined) setShowBrowser(true)
    }
  }, [openFiles, activePath])

  const activeFile = openFiles.find(file => file.path === activePath) ?? null

  return (
    <div className="dsh-wb-root">
      <style>{`
        .dsh-wb-root {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-width: 0;
          background: var(--dsw-alias-bg-base);
          border-left: 1px solid var(--dsw-alias-border-l2);
        }
        .dsh-wb-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          background: var(--dsw-alias-bg-l2);
        }
        .dsh-wb-title {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
          font-size: 14px;
          line-height: 20px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .dsh-wb-close {
          display: grid;
          flex: none;
          place-items: center;
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--dsw-alias-label-secondary);
          cursor: pointer;
        }
        .dsh-wb-close:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 8px;
        }
        .dsh-wb-pathbar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 8px;
          margin-bottom: 4px;
          border-radius: 8px;
          background: var(--dsw-alias-bg-l1);
        }
        .dsh-wb-path {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-secondary);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-wb-loading {
          flex: none;
          font-size: 12px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-error {
          padding: 8px 10px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-state-error-primary);
        }
        .dsh-wb-empty {
          padding: 12px 10px;
          font-size: 13px;
          line-height: 20px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-row {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 34px;
          padding: 4px 8px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font-size: 13px;
          line-height: 20px;
          text-align: left;
          cursor: pointer;
        }
        .dsh-wb-row:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-row:active {
          background: var(--dsw-alias-interactive-bg-active);
        }
        .dsh-wb-row-file {
          cursor: pointer;
        }
        .dsh-wb-row-file:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-folder-icon {
          flex: none;
          color: var(--dsw-alias-label-secondary);
        }
        .dsh-wb-badge {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 32px;
          height: 18px;
          padding: 0 4px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 700;
          line-height: 16px;
        }
        .dsh-wb-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-wb-size {
          flex: none;
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-tabs {
          display: flex;
          align-items: stretch;
          gap: 2px;
          padding: 6px 8px 0;
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          overflow-x: auto;
          background: var(--dsw-alias-bg-l2);
        }
        .dsh-wb-tab {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          flex: none;
          max-width: 150px;
          height: 28px;
          padding: 0 4px 0 8px;
          border-radius: 6px 6px 0 0;
          background: transparent;
          color: var(--dsw-alias-label-secondary);
          font-size: 12px;
          line-height: 18px;
        }
        .dsh-wb-tab:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-tab-label {
          flex: 1;
          min-width: 0;
          height: 100%;
          padding: 0;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-wb-tab-active {
          background: var(--dsw-alias-bg-base);
          color: var(--dsw-alias-label-primary);
        }
        .dsh-wb-tab-close {
          display: grid;
          flex: none;
          place-items: center;
          width: 18px;
          height: 18px;
          padding: 0;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--dsw-alias-label-tertiary);
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
        }
        .dsh-wb-tab-close:hover {
          background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-primary);
        }
        .dsh-wb-codeblock {
          margin: 0;
        }
        .dsh-wb-preview {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
        }
        @media (max-width: 520px) {
          .dsh-wb-header {
            padding: 10px 12px;
          }
          .dsh-wb-body {
            padding: 6px;
          }
          .dsh-wb-pathbar {
            padding: 6px;
          }
          .dsh-wb-row {
            min-height: 40px;
          }
        }
      `}</style>
      <div className="dsh-wb-header">
        <span className="dsh-wb-title">
          <IconFolderOpenOutline16 />
          工作区文件
        </span>
        <button
          type="button"
          className="dsh-wb-close"
          onClick={() => ctx.layout.closeDetails()}
          aria-label="关闭工作区文件"
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      {openFiles.length > 0 && (
        <div className="dsh-wb-tabs">
          <div className={`dsh-wb-tab ${showBrowser ? 'dsh-wb-tab-active' : ''}`}>
            <button
              type="button"
              className="dsh-wb-tab-label"
              onClick={() => setShowBrowser(true)}
            >
              📁 文件
            </button>
          </div>
          {openFiles.map(file => (
            <div
              key={file.path}
              className={`dsh-wb-tab ${activePath === file.path && !showBrowser ? 'dsh-wb-tab-active' : ''}`}
            >
              <button
                type="button"
                className="dsh-wb-tab-label"
                onClick={() => {
                  setActivePath(file.path)
                  setShowBrowser(false)
                }}
              >
                {file.name}
              </button>
              <button
                type="button"
                className="dsh-wb-tab-close"
                onClick={() => closeFile(file.path)}
                aria-label={`关闭 ${file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="dsh-wb-body">
        {showBrowser ? (
          <WorkspaceFileBrowser
            useSessions={props.useSessions}
            onOpenFile={(path, name) => void openFile(path, name)}
          />
        ) : activeFile !== null ? (
          <div className="dsh-wb-preview">
            {loadingPath === activeFile.path && <div className="dsh-wb-empty">加载中…</div>}
            {activeFile.error !== undefined && activeFile.error !== '' && (
              <div className="dsh-wb-error">{activeFile.error}</div>
            )}
            {loadingPath !== activeFile.path && activeFile.error === undefined && (
              <CodeBlock
                className="dsh-wb-codeblock"
                code={activeFile.content}
                lang={langFromName(activeFile.name)}
              />
            )}
          </div>
        ) : (
          <div className="dsh-wb-empty">打开文件后在此预览</div>
        )}
      </div>
    </div>
  )
}

/** 侧边栏底部入口：用于关闭右侧栏后重新打开。 */
interface FooterActionProps {
  wide: boolean
}

function WorkspaceFooterAction(ctx: ClientContext, props: FooterActionProps): React.ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<IconFolderOpenOutline16 />}
      onClick={() => {
        // 手机端从左侧抽屉进入时，先收起左侧抽屉，避免左右两个抽屉同时打开。
        if (window.matchMedia('(max-width: 768px)').matches) {
          ctx.layout.toggleSidebar()
        }
        ctx.layout.openDetails()
      }}
      aria-label="工作区文件"
      title="工作区文件"
    >
      {props.wide && '工作区文件'}
    </Button>
  )
}

export function apply(ctx: ClientContext): void {
  const DetailsComponent = (props: DetailsProps): React.ReactElement => WorkspaceDetailsPanel(ctx, props)
  const FooterComponent = (props: FooterActionProps): React.ReactElement => WorkspaceFooterAction(ctx, props)

  ctx.effect(() => ctx.slots.inject('details', () =>
    ctx.slots.register(
      {
        name: 'details',
        id: 'workspace-browser',
        priority: -1,
        label: () => '工作区文件',
      },
      DetailsComponent,
    ),
  ), 'workspace-browser: details panel')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'workspace-browser',
        order: 60,
        label: () => '工作区文件',
      },
      FooterComponent,
    ),
  ), 'workspace-browser: footer reopen action')
}
