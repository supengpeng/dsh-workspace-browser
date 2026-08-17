/**
 * @dsh-external/workspace-browser — Web UI 半。
 *
 * 尽量接近 VS Code 的工作区文件体验：
 * - 左侧资源管理器树（目录可展开/折叠）；
 * - 右侧多标签编辑器，支持编辑、保存、脏标记、行号、状态栏；
 * - 通过宿主 HTTP API `/workspace-browser/api/list|read|write` 读写文件。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconCloseOutline16, IconFolderOpenOutline16,
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

interface WriteResponse {
  ok: boolean
  path?: string
  error?: string
}

interface OpenFile {
  path: string
  name: string
  content: string
  originalContent: string
  error?: string
  dirty: boolean
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

/** 从文件名推断编辑器的语言标识。 */
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

// ─── 资源管理器树 ─────────────────────────────────────────────────────────────

interface WorkspaceExplorerProps {
  sessionId: string
  onOpenFile: (path: string, name: string) => void
}

interface TreeRowProps {
  entry: WorkspaceEntry
  depth: number
  expanded: Record<string, boolean>
  childrenMap: Record<string, WorkspaceEntry[]>
  onToggle: (entry: WorkspaceEntry) => void
  onOpenFile: (path: string, name: string) => void
}

function TreeRow({
  entry,
  depth,
  expanded,
  childrenMap,
  onToggle,
  onOpenFile,
}: TreeRowProps): React.ReactElement {
  const isDirectory = entry.type === 'directory'
  const isExpanded = expanded[entry.path] === true
  const kind = fileKind(entry.name)
  return (
    <div>
      <button
        type="button"
        className="dsh-wb-tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => isDirectory ? onToggle(entry) : onOpenFile(entry.path, entry.name)}
        title={entry.path}
      >
        <span className="dsh-wb-tree-arrow">{isDirectory ? (isExpanded ? '▾' : '▸') : ''}</span>
        {isDirectory ? (
          <IconFolderOpenOutline16 className="dsh-wb-folder-icon" />
        ) : (
          <span
            className="dsh-wb-tree-badge"
            style={{ color: kind.color, background: kind.background }}
          >
            {kind.label}
          </span>
        )}
        <span className="dsh-wb-tree-name">{entry.name}</span>
      </button>
      {isDirectory && isExpanded && (
        <div>
          {childrenMap[entry.path] === undefined ? (
            <div className="dsh-wb-tree-loading" style={{ paddingLeft: 22 + depth * 14 }}>加载中…</div>
          ) : (
            childrenMap[entry.path].map(child => (
              <TreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                childrenMap={childrenMap}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function WorkspaceExplorer({ sessionId, onOpenFile }: WorkspaceExplorerProps): React.ReactElement {
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [childrenMap, setChildrenMap] = useState<Record<string, WorkspaceEntry[]>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const loadRoot = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ sessionId })
      const response = await fetch(`${API}/list?${params.toString()}`)
      const data = await response.json() as ListResponse
      if (!data.ok || data.entries === undefined) throw new Error(data.error ?? '加载失败')
      setRootEntries(data.entries)
      setExpanded({})
      setChildrenMap({})
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void loadRoot()
  }, [loadRoot])

  const toggleDirectory = useCallback(async (entry: WorkspaceEntry): Promise<void> => {
    if (expanded[entry.path]) {
      setExpanded(previous => ({ ...previous, [entry.path]: false }))
      return
    }
    setExpanded(previous => ({ ...previous, [entry.path]: true }))
    if (childrenMap[entry.path] !== undefined) return
    try {
      const params = new URLSearchParams({ sessionId, path: entry.path })
      const response = await fetch(`${API}/list?${params.toString()}`)
      const data = await response.json() as ListResponse
      if (!data.ok || data.entries === undefined) throw new Error(data.error ?? '加载失败')
      setChildrenMap(previous => ({ ...previous, [entry.path]: data.entries ?? [] }))
    } catch (toggleError) {
      setChildrenMap(previous => ({ ...previous, [entry.path]: [] }))
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    }
  }, [childrenMap, expanded, sessionId])

  return (
    <div className="dsh-wb-explorer">
      <div className="dsh-wb-explorer-header">资源管理器</div>
      {loading && <div className="dsh-wb-tree-loading">加载中…</div>}
      {error !== '' && <div className="dsh-wb-error">{error}</div>}
      {!loading && rootEntries.length === 0 && error === '' && (
        <div className="dsh-wb-empty">空目录</div>
      )}
      {rootEntries.map(entry => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={0}
          expanded={expanded}
          childrenMap={childrenMap}
          onToggle={entry => void toggleDirectory(entry)}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  )
}

// ─── 编辑器 ──────────────────────────────────────────────────────────────────

interface EditorPaneProps {
  files: OpenFile[]
  activePath: string | null
  loadingPath: string | null
  savingPath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onChange: (path: string, content: string) => void
  onSave: (path: string) => void
  onShowExplorer: () => void
}

function EditorPane({
  files,
  activePath,
  loadingPath,
  savingPath,
  onSelect,
  onClose,
  onChange,
  onSave,
  onShowExplorer,
}: EditorPaneProps): React.ReactElement {
  const activeFile = files.find(file => file.path === activePath) ?? null
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })

  const lineCount = activeFile ? activeFile.content.split('\n').length : 1
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1)

  const syncScroll = (): void => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  const updateCursor = (element: HTMLTextAreaElement): void => {
    const value = element.value
    const upTo = value.slice(0, element.selectionStart)
    const line = upTo.split('\n').length
    const column = upTo.length - upTo.lastIndexOf('\n')
    setCursor({ line, column })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!activeFile) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave(activeFile.path)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const element = event.currentTarget
      const start = element.selectionStart
      const end = element.selectionEnd
      const next = activeFile.content.slice(0, start) + '  ' + activeFile.content.slice(end)
      onChange(activeFile.path, next)
      requestAnimationFrame(() => {
        element.selectionStart = element.selectionEnd = start + 2
        updateCursor(element)
      })
    }
  }

  return (
    <div className="dsh-wb-editor">
      <div className="dsh-wb-tabs">
        <button type="button" className="dsh-wb-tab dsh-wb-tab-explorer" onClick={onShowExplorer}>
          📁 资源管理器
        </button>
        {files.map(file => (
          <div
            key={file.path}
            className={`dsh-wb-tab ${activePath === file.path ? 'dsh-wb-tab-active' : ''}`}
          >
            <button
              type="button"
              className="dsh-wb-tab-label"
              onClick={() => onSelect(file.path)}
              title={file.path}
            >
              {file.name}
              {file.dirty && <span className="dsh-wb-dirty">●</span>}
            </button>
            <button
              type="button"
              className="dsh-wb-tab-close"
              onClick={() => onClose(file.path)}
              aria-label={`关闭 ${file.name}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="dsh-wb-editor-body">
        {activeFile === null ? (
          <div className="dsh-wb-welcome">从左侧资源管理器选择文件开始编辑</div>
        ) : activeFile.error !== undefined && activeFile.error !== '' ? (
          <div className="dsh-wb-error">{activeFile.error}</div>
        ) : (
          <>
            <div className="dsh-wb-gutter" ref={gutterRef}>
              {lineNumbers.map(line => <div key={line} className="dsh-wb-gutter-line">{line}</div>)}
            </div>
            <textarea
              ref={textareaRef}
              className="dsh-wb-textarea"
              value={activeFile.content}
              spellCheck={false}
              onChange={event => onChange(activeFile.path, event.target.value)}
              onScroll={syncScroll}
              onSelect={event => updateCursor(event.currentTarget)}
              onClick={event => updateCursor(event.currentTarget)}
              onKeyDown={handleKeyDown}
            />
          </>
        )}
      </div>
      {activeFile !== null && activeFile.error === undefined && (
        <div className="dsh-wb-statusbar">
          <span>{langFromName(activeFile.name) ?? 'Plain Text'}</span>
          <span>Ln {cursor.line}, Col {cursor.column}</span>
          <span>UTF-8</span>
          <span>LF</span>
          <span className="dsh-wb-status-save">
            {savingPath === activeFile.path ? '保存中…' : activeFile.dirty ? '未保存' : '已保存'}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── 详情面板（右侧栏） ───────────────────────────────────────────────────────

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
  const [showExplorer, setShowExplorer] = useState<boolean>(() => !window.matchMedia('(max-width: 768px)').matches)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState<string | null>(null)

  const openFile = useCallback(async (path: string, name: string): Promise<void> => {
    if (openFiles.some(file => file.path === path)) {
      setActivePath(path)
      return
    }
    setLoadingPath(path)
    try {
      const params = new URLSearchParams({ sessionId: props.sessionId, path })
      const response = await fetch(`${API}/read?${params.toString()}`)
      const data = await response.json() as ReadResponse
      if (!data.ok || data.content === undefined) throw new Error(data.error ?? '读取失败')
      const file: OpenFile = {
        path,
        name,
        content: data.content,
        originalContent: data.content,
        dirty: false,
      }
      setOpenFiles(previous => [...previous, file])
      setActivePath(path)
    } catch (readError) {
      const file: OpenFile = {
        path,
        name,
        content: '',
        originalContent: '',
        dirty: false,
        error: readError instanceof Error ? readError.message : String(readError),
      }
      setOpenFiles(previous => [...previous, file])
      setActivePath(path)
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
    }
  }, [openFiles, activePath])

  const changeFile = useCallback((path: string, content: string): void => {
    setOpenFiles(previous => previous.map(file => {
      if (file.path !== path) return file
      return { ...file, content, dirty: content !== file.originalContent }
    }))
  }, [])

  const saveFile = useCallback(async (path: string): Promise<void> => {
    const file = openFiles.find(item => item.path === path)
    if (!file) return
    setSavingPath(path)
    try {
      const response = await fetch(`${API}/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content: file.content }),
      })
      const data = await response.json() as WriteResponse
      if (!response.ok || !data.ok) throw new Error(data.error ?? '保存失败')
      setOpenFiles(previous => previous.map(item => {
        if (item.path !== path) return item
        return { ...item, originalContent: item.content, dirty: false }
      }))
    } catch (saveError) {
      setOpenFiles(previous => previous.map(item => {
        if (item.path !== path) return item
        return { ...item, error: saveError instanceof Error ? saveError.message : String(saveError) }
      }))
    } finally {
      setSavingPath(null)
    }
  }, [openFiles])

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
          padding: 8px 12px;
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          background: var(--dsw-alias-bg-l2);
        }
        .dsh-wb-title {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
          font-size: 13px;
          line-height: 20px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .dsh-wb-header-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .dsh-wb-close {
          display: grid;
          flex: none;
          place-items: center;
          width: 26px;
          height: 26px;
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
          display: flex;
          min-height: 0;
        }
        .dsh-wb-explorer {
          flex: none;
          width: 168px;
          min-width: 0;
          overflow-y: auto;
          border-right: 1px solid var(--dsw-alias-border-l2);
          background: var(--dsw-alias-bg-l1);
          padding: 4px 0;
        }
        .dsh-wb-explorer-header {
          padding: 6px 10px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-tree-row {
          display: flex;
          align-items: center;
          gap: 4px;
          width: 100%;
          min-height: 26px;
          padding: 2px 8px 2px 8px;
          border: none;
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font-size: 12px;
          line-height: 18px;
          text-align: left;
          cursor: pointer;
          overflow: hidden;
        }
        .dsh-wb-tree-row:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-tree-arrow {
          flex: none;
          width: 14px;
          color: var(--dsw-alias-label-tertiary);
          font-size: 10px;
        }
        .dsh-wb-folder-icon {
          flex: none;
          color: var(--dsw-alias-label-secondary);
        }
        .dsh-wb-tree-badge {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 14px;
          padding: 0 3px;
          border-radius: 3px;
          font-size: 8px;
          font-weight: 700;
          line-height: 14px;
        }
        .dsh-wb-tree-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-wb-tree-loading {
          padding: 4px 10px;
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-editor {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          background: var(--dsw-alias-bg-base);
        }
        .dsh-wb-tabs {
          display: flex;
          align-items: stretch;
          gap: 2px;
          padding: 4px 6px 0;
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          overflow-x: auto;
          background: var(--dsw-alias-bg-l2);
        }
        .dsh-wb-tab {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          flex: none;
          max-width: 160px;
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
        .dsh-wb-tab-active {
          background: var(--dsw-alias-bg-base);
          color: var(--dsw-alias-label-primary);
        }
        .dsh-wb-tab-explorer {
          border: none;
          background: transparent;
          color: var(--dsw-alias-label-secondary);
          cursor: pointer;
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
        .dsh-wb-dirty {
          margin-left: 4px;
          color: var(--dsw-alias-state-business-primary);
          font-size: 10px;
        }
        .dsh-wb-editor-body {
          flex: 1;
          display: flex;
          min-height: 0;
          overflow: hidden;
        }
        .dsh-wb-gutter {
          flex: none;
          width: 44px;
          overflow: hidden;
          padding: 8px 0;
          background: var(--dsw-alias-bg-l1);
          border-right: 1px solid var(--dsw-alias-border-l2);
          text-align: right;
          user-select: none;
        }
        .dsh-wb-gutter-line {
          padding: 0 8px 0 0;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 20px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-wb-textarea {
          flex: 1;
          min-width: 0;
          min-height: 0;
          padding: 8px 12px;
          border: none;
          outline: none;
          resize: none;
          background: var(--dsw-alias-bg-base);
          color: var(--dsw-alias-label-primary);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 20px;
          tab-size: 2;
          white-space: pre;
          overflow: auto;
        }
        .dsh-wb-statusbar {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: none;
          min-height: 22px;
          padding: 0 10px;
          border-top: 1px solid var(--dsw-alias-border-l2);
          background: var(--dsw-alias-bg-l2);
          color: var(--dsw-alias-label-secondary);
          font-size: 11px;
          line-height: 22px;
          white-space: nowrap;
          overflow: hidden;
        }
        .dsh-wb-status-save {
          margin-left: auto;
        }
        .dsh-wb-welcome {
          display: grid;
          flex: 1;
          place-items: center;
          padding: 20px;
          color: var(--dsw-alias-label-tertiary);
          font-size: 13px;
          text-align: center;
        }
        .dsh-wb-error {
          padding: 8px 10px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-state-error-primary);
        }
        .dsh-wb-empty {
          padding: 8px 10px;
          font-size: 12px;
          color: var(--dsw-alias-label-tertiary);
        }
        @media (max-width: 768px) {
          .dsh-wb-explorer {
            width: 132px;
          }
        }
        @media (max-width: 520px) {
          .dsh-wb-explorer {
            display: none;
          }
        }
      `}</style>
      <div className="dsh-wb-header">
        <span className="dsh-wb-title">
          <IconFolderOpenOutline16 />
          工作区文件
        </span>
        <div className="dsh-wb-header-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowExplorer(previous => !previous)}
            aria-label="切换资源管理器"
          >
            {showExplorer ? '隐藏资源管理器' : '显示资源管理器'}
          </Button>
          <button
            type="button"
            className="dsh-wb-close"
            onClick={() => ctx.layout.closeDetails()}
            aria-label="关闭工作区文件"
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
      </div>
      <div className="dsh-wb-body">
        {showExplorer && (
          <WorkspaceExplorer
            sessionId={props.sessionId}
            onOpenFile={(path, name) => void openFile(path, name)}
          />
        )}
        <EditorPane
          files={openFiles}
          activePath={activePath}
          loadingPath={loadingPath}
          savingPath={savingPath}
          onSelect={setActivePath}
          onClose={closeFile}
          onChange={changeFile}
          onSave={path => void saveFile(path)}
          onShowExplorer={() => setShowExplorer(true)}
        />
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
