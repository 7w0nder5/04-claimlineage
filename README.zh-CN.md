# Project 04 · ClaimLineage

> Independent GitHub Project 04

ClaimLineage 是一个本地优先的证据工作区：把论断连接到不可变来源快照中的精确引文，检测原始来源是否漂移，并导出可由另一台机器离线验证的证据包。

它回答的是一个边界清晰的问题：**这个论断是否仍然指向同一组已保存的证据字节？** 它不判断论断或来源是否真实。

[English](README.md)

## 两分钟体验

只需要 Node.js 20 或更高版本，无运行时依赖，也不需要安装步骤。

```sh
node packages/cli/src/cli.js init demo --name "示例调查"
node packages/cli/src/cli.js import examples/source.txt --workspace demo
node packages/cli/src/cli.js list --workspace demo
```

复制 `list` 输出的快照 ID，再用来源中仅出现一次的原文创建论断：

```sh
node packages/cli/src/cli.js claim add --workspace demo --snapshot <snapshot-id> --statement "存档页面之后仍可离线校验。" --quote "A saved source snapshot can be verified later"
node packages/cli/src/cli.js verify --workspace demo
node packages/cli/src/cli.js bundle export demo.clb --workspace demo
node packages/cli/src/cli.js bundle verify demo.clb
```

启动本地网页界面：

```sh
node packages/cli/src/cli.js serve --workspace demo
```

打开命令输出的本机地址。服务只监听 `127.0.0.1`，每次启动生成新的会话令牌，不包含分析脚本、Cookie 或远程资源。

## 工作流程

1. 初始化工作区，生成版本化元数据和按内容寻址的对象仓库。
2. 导入本地文件、通过本地界面上传文件，或显式抓取一个公开 HTTP/HTTPS 资源。
3. 输入论断与精确引文；引文必须在 UTF-8 快照中只出现一次。
4. 校验全部 SHA-256、字节长度和引文选择器。
5. 比较本地原文件与快照，发现来源漂移但不改写存档。
6. 导出确定性的 `.clb` 证据包；绝对本地路径不会进入证据包。

## 可靠性边界

- 工作区和输出文件均不覆盖已有内容。
- 元数据写入使用互斥锁、临时文件、同步和原子重命名。
- 每次重定向都会重新校验协议并重新解析地址；任一解析结果属于私有、回环、链路本地、保留、文档或组播地址时立即停止。
- 拒绝 URL 凭据、HTTPS 降级、压缩响应、超过 10 MiB 的响应和超过五次的重定向。
- 证据包拒绝缺失、损坏、格式错误或未引用的对象，并限制为 64 MiB。
- 本地网页写请求要求会话令牌、精确 Host 和精确 Origin。

完整说明见[安全模型](docs/spec/security.md)。这些机制验证内容完整性，不验证作者身份、来源真实性、事实正确性或文件安全性。

## 开发与验收

```sh
npm test
npm run check
npm run test:coverage
```

测试覆盖规范化 JSON、UTF-8 与字节序标记、精确引文、引用完整性、对象篡改、并发写入锁、来源漂移、确定性导入导出、网络地址策略、重定向、体积与编码限制、命令行退出码以及网页安全边界。CI 在 Linux、Windows、macOS 的 Node.js 20 和 24 上运行。

详细资料：

- [命令行参考](docs/CLI.md)
- [数据模型](docs/spec/data-model.md)
- [证据包格式](docs/BUNDLE_FORMAT.md)
- [长期路线图](docs/ROADMAP.md)
- [贡献说明](CONTRIBUTING.md)

## 许可证

[MIT](LICENSE)
