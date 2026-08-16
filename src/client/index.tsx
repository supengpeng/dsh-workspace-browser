/**
 * @dsh-external/workspace-browser — Web UI 半。
 *
 * 在侧边栏 `sidebar.files` 注册“工作区文件”面板：显示当前会话工作区根目录，
 * 点击目录继续向下浏览，提供“返回根目录”按钮。
 * 数据来自宿主 HTTP API `/workspace-browser/api/list`。
 */
import React, { useCallback, useEffect, useState } from 'react'

export const inject = ['slots']

/** slots 服务的结构化视图。 */
interface SlotsFace {
  inject(key: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

type ClientContext = {
  slots: SlotsFace
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

interface SidebarFilesProps {
  wide: boolean
  expandSidebar: () => void
  useSessions: UseSessions
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

function WorkspaceFileBrowser(props: SidebarFilesProps): React.ReactElement {
  const { useSessions } = props
  const list = useSessions(state => state)
  const sessionId = list.current
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)

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

  const panelStyle: React.CSSProperties = {
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.7,
    color: 'var(--dsw-alias-label-primary, #ddd)',
  }
  const headerStyle: React.CSSProperties = {
    fontWeight: 600,
    marginBottom: 4,
    color: 'var(--dsw-alias-label-primary, #ddd)',
  }
  const pathStyle: React.CSSProperties = {
    color: 'var(--dsw-alias-label-dimmed, #888)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
  const ghostButtonStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2, #444)',
    color: 'var(--dsw-alias-label-primary, #ccc)',
    borderRadius: 6,
    padding: '1px 6px',
    fontSize: 12,
    cursor: 'pointer',
  }

  if (sessionId === undefined) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>📁 工作区文件</div>
        <div style={pathStyle}>当前没有会话</div>
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button
          style={{ ...ghostButtonStyle, border: 'none', padding: 0, fontSize: 12 }}
          onClick={() => setCollapsed(value => !value)}
          aria-label={collapsed ? '展开工作区文件' : '折叠工作区文件'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span style={headerStyle}>📁 工作区文件</span>
        {rootPath !== null && currentPath !== null && currentPath !== rootPath && (
          <button style={ghostButtonStyle} onClick={() => void load(rootPath)}>⬆ 根目录</button>
        )}
      </div>
      {!collapsed && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ ...pathStyle, flex: 1 }}>{currentPath ?? '加载中…'}</span>
            {loading && <span style={pathStyle}>加载中…</span>}
          </div>
          {error !== '' && <div style={{ color: '#e5534b', marginBottom: 4 }}>{error}</div>}
          {entries.length === 0 && !loading && error === '' && <div style={pathStyle}>(空目录)</div>}
          {entries.map(entry => (
            <div key={entry.path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {entry.type === 'directory' ? (
                <button
                  style={{ ...ghostButtonStyle, border: 'none', padding: 0 }}
                  onClick={() => void load(entry.path)}
                >
                  📁 {entry.name}/
                </button>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      flex: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 34,
                      padding: '0 4px',
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      lineHeight: '16px',
                      color: fileKind(entry.name).color,
                      background: fileKind(entry.name).background,
                    }}
                  >
                    {fileKind(entry.name).label}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                    {entry.size !== undefined ? ` (${fmtBytes(entry.size)})` : ''}
                  </span>
                </span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  const Component = (props: SidebarFilesProps): React.ReactElement => WorkspaceFileBrowser(props)
  ctx.effect(() => ctx.slots.inject('sidebar.files', () =>
    ctx.slots.register(
      {
        name: 'sidebar.files',
        id: 'workspace-browser',
        order: 50,
        label: () => '工作区文件',
      },
      Component,
    ),
  ), 'workspace-browser: sidebar files')
}
