# Abalone documentation

Start with the guide for your task. Protocol documents describe implemented
interfaces and their limits; a protocol or passing fixture does not qualify a
live service.

| Task | Document |
| --- | --- |
| Open and close the friend preview | [Getting started](getting-started.md) and [entry skill](../skills/abalone-incognito/SKILL.md) |
| Understand trust, isolation and retention | [Security profiles](security.md) |
| Understand the code and why it is shipped | [Architecture and layout](architecture.md) |
| Build, test and contribute | [Contributing](../CONTRIBUTING.md) and [development workflow](development.md) |
| Prepare and qualify a distribution | [Release procedure](release.md) |
| Exercise the source-only gift wrapper | [Development gift trial](gift-trial.md), [schema](coupon-first-use.schema.json) and [template](coupon-first-use.example.json) |
| Integrate coupon redemption | [Coupon protocol](protocols/coupon.md) and [NEAR adapter](protocols/near-adapter.md) |
| Inspect trace encryption and recovery | [Trace format](protocols/trace-store.md) |
| Integrate delegated tasks and verification | [Task protocol](protocols/task-v1.md), [runner interface](protocols/runner-task.md) and [receipts](protocols/receipt-v1.md) |
| Inspect the CDP browser interface | [Browser grants](protocols/browser-grant.md) |
| Use the separate MCP interface | [MCP quickstart](mcp-quickstart.md) |
| Qualify later network isolation | [VPN qualification](vpn-qualification.md) |
| Find current product priorities | [Roadmap](roadmap.md) and [public issues](https://github.com/amiller/abalone/issues) |

Keep supported instructions, security reasoning and interface specifications here.
Working notes, worker assignments, local release coordination and individual
session feedback belong in a private supplemental workspace or a scoped issue.
An outside contributor needs only this repository.
