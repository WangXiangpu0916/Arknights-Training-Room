# 项目协作规则

## 本地发布产物

- 本地发布只允许保留一个解包目录：`release/win-unpacked`。
- 发布新版本时，必须使用最新构建内容覆盖 `release/win-unpacked`，不得创建 `release/<version>/win-unpacked`、`output/<version>/win-unpacked` 等并存目录。
- 本地发布完成后，删除旧版本的安装包、Portable 包、blockmap、临时解包目录和其他仅属于旧版本的构建产物；`release` 中只保留最新版本产物。
- 如果 `release/win-unpacked` 中的应用正在运行，应先关闭该实例，再执行覆盖或清理，避免因文件占用产生额外发布目录。
- 发布完成后必须检查整个仓库，确认只有一个名为 `win-unpacked` 的目录，并核对其中 `训练室.exe` 的文件版本与当前 `package.json` 版本一致。
