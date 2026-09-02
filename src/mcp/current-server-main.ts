import { createOnDemandCurrentWechatDependencies } from "./live-bootstrap.js";
import { connectCurrentWechatMcpStdio } from "./current-server.js";

await connectCurrentWechatMcpStdio(createOnDemandCurrentWechatDependencies());
