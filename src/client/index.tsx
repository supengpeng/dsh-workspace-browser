/**
 * @dsh-external/workspace-browser — Web UI 半。
 *
 * 尽量接近 VS Code 的工作区文件体验：
 * - 左侧资源管理器树（目录可展开/折叠）；
 * - 右侧多标签编辑器，支持编辑、保存、脏标记、行号、状态栏；
 * - 通过宿主 HTTP API `/workspace-browser/api/list|read|write` 读写文件。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  saveError?: string
  dirty: boolean
}

const API = '/workspace-browser/api'

const fmtBytes = (size: number): string =>
  size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024 ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`

/** 官方风格文件图标：使用品牌色块 + 官方缩写，常见格式有专属图标。 */
function BrandSquare({
  color,
  text,
  textColor = '#fff',
  size = 16,
}: {
  color: string
  text: string
  textColor?: string
  size?: number
}): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={text} className="dsh-wb-file-icon">
      <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill={color} />
      <text
        x="8"
        y="11.5"
        textAnchor="middle"
        fontSize="7"
        fontWeight="700"
        fill={textColor}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {text}
      </text>
    </svg>
  )
}

function GenericFileIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="file" className="dsh-wb-file-icon">
      <path d="M3 1h6l4 4v10H3z" fill="#d1d5db" />
      <path d="M9 1v4h4" fill="#9ca3af" />
    </svg>
  )
}

function ImageFileIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="image" className="dsh-wb-file-icon">
      <rect x="1" y="2" width="14" height="12" rx="2" fill="#c9518f" />
      <circle cx="5.5" cy="6" r="1.5" fill="#fff" />
      <path d="M2.5 13l4-4.5 3 3 2-2 2 2v1.5h-11z" fill="#fff" />
    </svg>
  )
}

function ArchiveFileIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="archive" className="dsh-wb-file-icon">
      <path d="M3 2h10v12H3z" fill="#8b5a2b" />
      <path d="M5 5h6M5 8h6M5 11h6" stroke="#f5e6d3" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6 2l1-1h2l1 1" fill="#6b4423" />
    </svg>
  )
}

function DatabaseFileIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="database" className="dsh-wb-file-icon">
      <ellipse cx="8" cy="3.5" rx="6" ry="2" fill="#6b7280" />
      <path d="M2 3.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9" fill="#9ca3af" />
      <path d="M2 8c0 1.1 2.7 2 6 2s6-.9 6-2" fill="#6b7280" />
    </svg>
  )
}

function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }): React.ReactElement {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  switch (ext) {
    case 'ts': case 'mts': case 'cts':
      return <BrandSquare color="#3178c6" text="TS" size={size} />
    case 'tsx':
      return <BrandSquare color="#3178c6" text="TSX" size={size} />
    case 'js': case 'mjs': case 'cjs':
      return <BrandSquare color="#f7df1e" text="JS" textColor="#1f2d3d" size={size} />
    case 'jsx':
      return <BrandSquare color="#61dafb" text="JSX" textColor="#1f2d3d" size={size} />
    case 'json':
      return <BrandSquare color="#c98a3d" text="{ }" size={size} />
    case 'md': case 'markdown':
      return <BrandSquare color="#083fa6" text="M↓" size={size} />
    case 'py':
      return <BrandSquare color="#3776ab" text="Py" size={size} />
    case 'css': case 'scss': case 'less':
      return <BrandSquare color="#1572b6" text="CSS" size={size} />
    case 'html': case 'htm':
      return <BrandSquare color="#e34c26" text="HTML" size={size} />
    case 'yaml': case 'yml':
      return <BrandSquare color="#cb171e" text="YML" size={size} />
    case 'sh': case 'bash': case 'zsh':
      return <BrandSquare color="#4eaa25" text=">_" size={size} />
    case 'go':
      return <BrandSquare color="#00ADD8" text="Go" textColor="#1f2d3d" size={size} />
    case 'rs':
      return <BrandSquare color="#000000" text="Rs" size={size} />
    case 'java':
      return <BrandSquare color="#f89820" text="Java" size={size} />
    case 'c':
      return <BrandSquare color="#555555" text="C" size={size} />
    case 'h':
      return <BrandSquare color="#555555" text="H" size={size} />
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh':
      return <BrandSquare color="#00599C" text="C++" size={size} />
    case 'cs':
      return <BrandSquare color="#68217A" text="C#" size={size} />
    case 'php':
      return <BrandSquare color="#777BB4" text="PHP" size={size} />
    case 'rb':
      return <BrandSquare color="#CC342D" text="Rb" size={size} />
    case 'swift':
      return <BrandSquare color="#F05138" text="Swift" size={size} />
    case 'kt': case 'kts':
      return <BrandSquare color="#7F52FF" text="Kt" size={size} />
    case 'vue':
      return <BrandSquare color="#42B883" text="V" size={size} />
    case 'svelte':
      return <BrandSquare color="#FF3E00" text="S" size={size} />
    case 'angular': case 'ng':
      return <BrandSquare color="#DD0031" text="A" size={size} />
    case 'sql':
      return <DatabaseFileIcon size={size} />
    case 'toml': case 'ini': case 'conf': case 'cfg':
      return <BrandSquare color="#6b7280" text="cfg" size={size} />
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico': case 'bmp':
      return <ImageFileIcon size={size} />
    case 'zip': case 'tar': case 'gz': case '7z': case 'rar':
      return <ArchiveFileIcon size={size} />
    case 'pdf':
      return <BrandSquare color="#e74c3c" text="PDF" size={size} />
    case 'doc': case 'docx':
      return <BrandSquare color="#2B579A" text="W" size={size} />
    case 'xls': case 'xlsx': case 'csv':
      return <BrandSquare color="#217346" text="X" size={size} />
    case 'ppt': case 'pptx':
      return <BrandSquare color="#D24726" text="P" size={size} />
    case 'lock':
      return <BrandSquare color="#b45309" text="🔒" size={size} />
    case 'exe': case 'bin': case 'dll':
      return <BrandSquare color="#6b7280" text="BIN" size={size} />
    default:
      return <GenericFileIcon size={size} />
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
          <FileTypeIcon name={entry.name} />
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
              <FileTypeIcon name={file.name} size={14} />
              <span className="dsh-wb-tab-name">{file.name}</span>
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
            {activeFile.saveError !== undefined && activeFile.saveError !== '' && (
              <div className="dsh-wb-error">{activeFile.saveError}</div>
            )}
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

interface WorkspaceFilesPanelProps {
  sessionId: string
  onClose?: () => void
}

function WorkspaceFilesPanel({ sessionId, onClose }: WorkspaceFilesPanelProps): React.ReactElement {
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
      const params = new URLSearchParams({ sessionId, path })
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
  }, [openFiles, sessionId])

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
      return { ...file, content, dirty: content !== file.originalContent, saveError: undefined }
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
        return { ...item, originalContent: item.content, dirty: false, saveError: undefined }
      }))
    } catch (saveError) {
      setOpenFiles(previous => previous.map(item => {
        if (item.path !== path) return item
        return { ...item, saveError: saveError instanceof Error ? saveError.message : String(saveError) }
      }))
    } finally {
      setSavingPath(null)
    }
  }, [openFiles])

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
          gap: 6px;
          width: 100%;
          min-height: 28px;
          padding: 3px 8px 3px 8px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font-size: 12px;
          line-height: 18px;
          text-align: left;
          cursor: pointer;
          overflow: hidden;
          transition: background 0.12s ease, color 0.12s ease;
        }
        .dsh-wb-tree-row:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-wb-tree-row:active {
          background: var(--dsw-alias-interactive-bg-active);
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
          box-shadow: inset 0 2px 0 var(--dsw-alias-state-business-primary);
        }
        .dsh-wb-tab-label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
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
        .dsh-wb-tab-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-wb-file-icon {
          display: block;
          flex: none;
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
          caret-color: var(--dsw-alias-state-business-primary);
        }
        .dsh-wb-textarea::selection {
          background: var(--dsw-alias-state-business-primary);
          color: #fff;
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
          {onClose !== undefined && (
            <button
              type="button"
              className="dsh-wb-close"
              onClick={onClose}
              aria-label="关闭工作区文件"
            >
              <IconCloseOutline16 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="dsh-wb-body">
        {showExplorer && (
          <WorkspaceExplorer
            sessionId={sessionId}
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
        />
      </div>
    </div>
  )
}

interface DetailsProps {
  sessionId: string
}

function WorkspaceDetailsPanel(ctx: ClientContext, props: DetailsProps): React.ReactElement {
  return (
    <WorkspaceFilesPanel
      sessionId={props.sessionId}
      onClose={() => ctx.layout.closeDetails()}
    />
  )
}

function WorkspaceConversationView(ctx: ClientContext): React.ReactElement | null {
  useLayoutEffect(() => {
    ctx.layout.openDetails()

    // 全局轻提示：不依赖当前视图组件存活，切回对话后仍会显示并自动消失。
    const el = document.createElement('div')
    el.textContent = '已在右侧打开工作区文件'
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:99999',
      'padding:10px 14px',
      'border-radius:8px',
      'background:var(--dsw-alias-bg-l2)',
      'border:1px solid var(--dsw-alias-border-l2)',
      'color:var(--dsw-alias-label-primary)',
      'font-size:13px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
      'pointer-events:none',
    ].join(';')
    document.body.appendChild(el)
    window.setTimeout(() => el.remove(), 2000)

    // 回到第一个/“对话”标签，让主内容区保持对话视图。
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const chatTab = tabs.find(tab => /对话|Chat|聊天/.test(tab.textContent ?? '')) ?? tabs[0]
    chatTab?.click()
  }, [ctx.layout])

  return null
}

export function apply(ctx: ClientContext): void {
  const DetailsComponent = (props: DetailsProps): React.ReactElement => WorkspaceDetailsPanel(ctx, props)
  const ConversationComponent = (): React.ReactElement | null => WorkspaceConversationView(ctx)

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

  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'workspace-files',
        order: 20,
        label: () => '工作区文件',
      },
      ConversationComponent,
    ),
  ), 'workspace-browser: conversation view')
}
