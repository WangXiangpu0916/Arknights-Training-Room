# 原生依赖许可证补充

`generate-third-party-licenses.mjs` 优先读取 Cargo.lock 对应 crate 内的 LICENSE/NOTICE。以下 crate 未随发布包包含完整文本，按其声明和原仓库补齐；升级对应 crate 时须重新核对：

- alloc-stdlib：Dropbox/rust-alloc-no-stdlib 的 BSD-3-Clause 许可。
- defmt-parser：knurling-rs/defmt 的 MIT 许可。
- webview2-com、webview2-com-sys、webview2-com-macros：wravery/webview2-rs 的 MIT 许可。
- selectors：Servo 项目，MPL-2.0，全文来自 https://www.mozilla.org/media/MPL/2.0/index.txt 。

NSIS 模板由 Tauri CLI 2.11.5 的官方模板定制，许可见 `../nsis/LICENSE.tauri`。
