/**
 * @dsh-external/workspace-browser — Web UI 半。
 *
 * 在会话输入框上方注册一个“工作区文件”dock：显示当前会话工作区根目录，
 * 点击目录可继续向下浏览，返回根目录按钮回到工作区根。
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

interface DockProps {
  sessionId: string
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

function WorkspaceBrowserDock(ctx: ClientContext, props: DockProps): React.ReactElement {
  const { sessionId } = props
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (path?: string): Promise<void> => {
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
    void load()
  }, [load])

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 10px',
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-primary, #ddd)',
    background: 'var(--dsw-alias-bg-base, #14161a)',
    border: '1px solid var(--dsw-alias-border-l1, #333)',
    borderRadius: 8,
  }
  const panelStyle: React.CSSProperties = {
    margin: '4px 10px 8px',
    padding: '8px 10px',
    maxHeight: 240,
    overflow: 'auto',
    fontSize: 12,
    lineHeight: 1.7,
    color: 'var(--dsw-alias-label-primary, #ddd)',
    background: 'var(--dsw-alias-bg-base, #14161a)',
    border: '1px solid var(--dsw-alias-border-l1, #333)',
    borderRadius: 8,
  }
  const buttonStyle: React.CSSProperties = {
    background: 'var(--dsw-alias-brand-primary, #4a9eff)',
    color: 'var(--dsw-alias-brand-primary-invert, #fff)',
    border: 'none',
    borderRadius: 6,
    padding: '2px 8px',
    fontSize: 12,
    cursor: 'pointer',
  }
  const ghostButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2, #444)',
    color: 'var(--dsw-alias-label-primary, #ccc)',
  }
  const pathStyle: React.CSSProperties = {
    color: 'var(--dsw-alias-label-dimmed, #888)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  return (
    <div>
      <div style={rowStyle}>
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>📁 工作区文件</span>
        <button style={buttonStyle} onClick={() => setExpanded(value => !value)} disabled={loading}>
          {expanded ? '收起' : '展开'}
        </button>
        {currentPath !== null && (
          <span style={{ ...pathStyle, flex: 1 }} title={currentPath}>{currentPath}</span>
        )}
        {loading && <span style={pathStyle}>加载中…</span>}
        {error !== '' && <span style={{ color: '#e5534b' }}>{error}</span>}
      </div>
      {expanded && (
        <div style={panelStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ ...pathStyle, flex: 1 }}>{currentPath ?? '加载中…'}</span>
            {rootPath !== null && currentPath !== null && currentPath !== rootPath && (
              <button style={ghostButtonStyle} onClick={() => void load(rootPath)}>⬆ 根目录</button>
            )}
          </div>
          {entries.length === 0 && !loading && <div style={pathStyle}>(空目录)</div>}
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
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📄 {entry.name}
                  {entry.size !== undefined ? ` (${fmtBytes(entry.size)})` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  const Dock = (props: DockProps): React.ReactElement => WorkspaceBrowserDock(ctx, props)
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'workspace-browser',
        order: 50,
        label: () => '工作区文件',
      },
      Dock,
    ),
  ), 'workspace-browser: dock')
}
