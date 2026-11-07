// 精简版不再包含 WASM 等静态资源（多渠道签名实现已整体移除）。
// 保留本脚本是为了让 `build:all` / `prepare` 的调用链保持稳定。
console.log('No static assets to copy (lite build)')
