# @dsh-external/workspace-browser

DeepSeek Harness 插件：在 Web UI 中浏览当前工作区文件夹的目录结构与文件列表，同时提供模型可见工具 `list_workspace`。

## 功能

### Web UI 文件浏览

- 侧边栏中显示“工作区文件”面板；
- 默认列出当前会话工作区根目录；
- 点击目录可继续向下浏览，提供“返回根目录”按钮；
- 面板可折叠/展开，折叠后只保留标题行；
- 文件按扩展名显示不同样式/颜色标记（TS、JS、JSON、MD、PY、CSS、HTML、YAML、图片、压缩包等）；
- 通过宿主 HTTP API `/workspace-browser/api/list` 读取目录，使用 `ctx.fs`，与模型工具共用同一套目录解析逻辑。

### 模型工具

注册一个模型可见工具 `list_workspace`：

- 不传 `path`：列出当前会话工作区根目录；
- 传相对路径（如 `packages/fs`）：在工作区内向下浏览；
- 传绝对路径：仅当路径位于工作区根之内时允许列出；
- `recursive: true`：递归列出子目录，`max_depth` 限制递归深度；
- `include_hidden: true`：包含 `.` 开头的隐藏文件/目录；
- 返回每个条目的名称、类型（`file` / `directory` / `other`）、显示路径、深度和文件大小；
- 超出 `maxEntries` 时返回 `truncated: true`。

实现基于 Harness 的 `ctx.fs` 服务（`resolve` / `listDir` / `contains`），
不直接读取 Node fs，因此也适用于远程或沙箱文件系统后端。

## 工具参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | `string` | 工作区根 | 要列出的目录 |
| `max_entries` | `number` | `maxEntries` | 单次最多返回的条目数 |
| `recursive` | `boolean` | `false` | 是否递归列出子目录 |
| `max_depth` | `number` | `maxDepth` | 递归深度上限 |
| `include_hidden` | `boolean` | `showHidden` | 是否包含隐藏文件/目录 |

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `root` | `string` | `''` | 工作区根目录；留空时使用会话 cwd，会话无 cwd 时使用 `ctx.fs` 后端默认 cwd |
| `maxEntries` | `number` | `1000` | 单次列出的最大条目数 |
| `maxDepth` | `number` | `5` | 默认递归深度上限 |
| `showHidden` | `boolean` | `false` | 默认是否显示隐藏文件/目录 |
| `allowOutsideRoot` | `boolean` | `false` | 是否允许列出工作区根之外的绝对路径 |

## 构建与注入

```bash
# 在插件目录执行
bash scripts/build.sh
```

在 dsh-super-injector 环境中：

```text
dev_build_plugin /root/dsh-routing-suite/workspace-browser
dev_inject_plugin /root/dsh-routing-suite/workspace-browser
```

也可以作为 bundle 安装到 profile：

```bash
dsh plugin --profile demo add ./dsh-external-workspace-browser-0.4.1.tgz
# 或从 GitHub 安装
dsh plugin --profile demo add github:supengpeng/dsh-workspace-browser#v0.4.1
```

## 使用示例

向模型提问：

> 列出当前工作区根目录，然后递归浏览 `packages/fs`，不要显示隐藏文件。

模型会调用 `list_workspace`，例如：

```json
{ "path": "packages/fs", "recursive": true, "max_depth": 3, "include_hidden": false }
```
