# MCP 接口

## 连接方式

MCP 使用标准输入/标准输出，每行一条 UTF-8 JSON-RPC 消息。适配器再通过
带随机令牌的本地命名管道连接桌面程序；没有 HTTP 监听端口。

客户端示例：

```json
{
  "mcpServers": {
    "psmetac": {
      "command": "node",
      "args": [
        "D:\\Projects\\PSMetaC\\src\\mcp.ts",
        "--data-dir",
        "D:\\PSMetaCData"
      ]
    }
  }
}
```

桌面程序或 `cli.ts serve` 必须先运行。

安装包部署后，MCP 客户端可把命令改为：

```text
<安装目录>\resources\scripts\psmetac-mcp.cmd
```

该启动器使用安装包内 Electron 的 Node 模式运行独立 stdio 适配器，并从
桌面程序共用的当前用户启动配置中寻找数据目录。它不会启动第二个桌面窗口，
也不会开放网络端口。

安装版 MCP 配置不需要 `args`：

```json
{
  "mcpServers": {
    "psmetac": {
      "command": "C:\\Users\\<当前用户>\\AppData\\Local\\Programs\\PaceSpace Metadata Cleaner\\resources\\scripts\\psmetac-mcp.cmd"
    }
  }
}
```

第一次使用前必须先打开桌面程序并完成向导，而且桌面程序需要保持运行。窗口
关闭到托盘不影响 MCP；完全退出后，本地命名管道也会关闭。优点是 MCP 不能
绕过桌面程序中的安全策略和任务账本；代价是它不是一个可在无人登录会话中
独立运行的 Windows 服务。

## 工具

| 工具 | 行为 |
|---|---|
| `get_capabilities` | 读取格式、版本和安全边界 |
| `list_profiles` | 读取三种门槛 |
| `submit_jobs` | 为明确文件创建独立任务 |
| `preflight` | 只读预检，不启动 Photoshop |
| `get_job` / `list_jobs` | 查询状态 |
| `cancel_job` | 合作取消，不强退 Photoshop |
| `get_report` | 读取单文件 JSON 报告 |
| `get_queue_status` | 查询队列 |
| `pause_queue` / `resume_queue` | 完成当前文件后暂停，以及恢复 |
| `stop_queue_after_current` | 完成当前文件后终止，并取消尚未开始的任务 |

严重安全暂停只能在桌面界面查看原因后解除。

## 幂等提交

`clientRequestId` 是调用者生成的稳定编号。相同编号再次提交时，服务器返回
原任务，不会再次清理。

示例参数：

```json
{
  "jobs": [
    {
      "sourcePath": "G:\\PSB_Safe_Inbox\\selected.psb",
      "profile": "standard",
      "runMode": "auto_if_eligible",
      "executionMode": "safe_copy",
      "backupSource": true,
      "requiredValidationChecks": [
        "target_xmp_removed",
        "structure_topology",
        "smart_object_success",
        "reopen_success",
        "pixel_exact"
      ],
      "outputMode": "specified_directory",
      "outputDir": "G:\\PSB_Safe_Output",
      "clientRequestId": "order-20260724-001"
    }
  ]
}
```

即使 MCP 参数请求了禁止路径或不允许的输出目录，桌面服务仍会拒绝。

`executionMode` 的默认值为 `safe_copy`。调用方只有明确传入 `in_place` 时才会
直接覆盖源文件；`backupSource` 决定执行前是否创建并校验备份。直存模式不使用
`outputDir`，并跳过保存后重新打开、结构、XMP 和像素校对。它支持无人值守，但
风险高于安全副本：建议始终传入 `backupSource: true`，并使用稳定且唯一的
`clientRequestId` 防止重复提交。

`requiredValidationChecks` 是可选数组。省略时使用桌面程序同样的严格默认值；
传入后，所有检查仍会执行并写入报告，但只有列出的可选项目会决定成品自动发布或
进入人工复核。可用值可通过 `get_capabilities` 查询。源文件变化、Photoshop
未完成等基础安全错误不在这个数组中，调用方不能关闭。
