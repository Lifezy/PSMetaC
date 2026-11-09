# 贡献指南

请先开 Issue 说明复现步骤、实际结果与预期结果。报告环境时包含 PSMetaC、Windows、
Photoshop 版本、文件格式、保存方式和是否存在嵌套智能对象/智能滤镜。

## 本地验证

在 Windows x64 上安装 Node 24 LTS 和项目指定的 pnpm：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run verify:package
pnpm run verify:public
```

提交前保持修改范围集中。影响 Photoshop JSX、路径授权、直存或文件恢复的修改需要
额外说明数据安全边界，以及是否完成隔离样本实机测试。只有自动测试通过不能说明
Photoshop 保存流程或跨版本兼容性已通过。

## 修改 Photoshop 资源

`vendor/psb_batch_tool/VENDOR_MANIFEST.json` 固定四个资源的大小和 SHA-256。
修改资源时同步清单；`verify:package` 与 `verify:dist` 会拒绝不匹配。
避免在用户文档上实验，不要通过强杀 Photoshop 实现取消。

## 可选界面验收

`scripts/ui-acceptance-alpha4*.mjs` 使用 Playwright 连接专用测试实例的本机 CDP。
Playwright 不属于应用运行依赖；请自行提供可用的 `playwright` 模块，或通过
`PSMETAC_PLAYWRIGHT_ROOT` 指定其模块路径。使用隔离用户目录，保持队列无生产任务，
先完成该测试目录的首次引导，再运行验收。

```powershell
$env:PSMETAC_UI_TEST_PROFILE = Join-Path $PWD '.ui-test-profile'
# 在单独的终端启动测试实例并完成首次引导
.\node_modules\.bin\electron.cmd . --remote-debugging-port=9223
# 使用相同工程目录的另一个终端运行
node scripts/ui-acceptance-alpha4.mjs .test-artifacts/ui
```

CDP 会暴露测试实例的控制能力，请只绑定本机并在测试结束后退出。

## 公开资料边界

请勿提交 PSD/PSB、客户图片、数据库、日志、诊断 ZIP、真实配置、密钥、个人路径或
截图中的私人信息。优先使用合成样本；不要在 Issue 中粘贴原始诊断包。
项目的 MIT 许可证适用于你有权贡献的代码，提交贡献表示你有权按该许可证提供修改。
