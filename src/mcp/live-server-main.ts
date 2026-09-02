import { runCoordinatedWechatMcpMain } from "./coordinated-server-main.js";
import { connectLiveWechatMcpStdio } from "./live-server.js";

await runCoordinatedWechatMcpMain(connectLiveWechatMcpStdio);
