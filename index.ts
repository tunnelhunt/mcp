#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, ChildProcess } from "child_process";
import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const server = new McpServer(
  {
    name: "tunnelhunt",
    version: "1.0.0",
  }
);

// Map to keep track of active tunnels
const activeTunnels = new Map<string, ChildProcess>();
const tunnelLogs = new Map<string, string[]>();

server.registerTool(
  "start_tunnel",
  {
    description: "Start a Tunnelhunt reverse SSH tunnel to expose a local port to the internet. Returns the public URL.",
    inputSchema: {
      port: z.number().describe("The local port to expose (e.g. 3000)"),
      subdomain: z.string().optional().describe("(Optional) A specific subdomain to request. E.g. 'my-app'. Defaults to random."),
    }
  },
  async ({ port, subdomain: requestedSubdomain }) => {
    if (isNaN(port)) {
      throw new Error("Port must be a valid number");
    }

    const domain = process.env.TUNNEL_DOMAIN || "tunnelhunt.ru";
    const remoteHost = `srv.${domain}`;
    const remotePort = process.env.TUNNEL_PORT || "2222";
    
    const remoteBind = requestedSubdomain ? `${requestedSubdomain}:80` : "80";

    return new Promise((resolve, reject) => {
      const args = [
        "-p", remotePort,
        "-R", `${remoteBind}:localhost:${port}`,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-T", // Disable pseudo-terminal allocation
        remoteHost
      ];

      console.error(`Spawning: ssh ${args.join(" ")}`);
      const sshProcess = spawn("ssh", args);

      let subdomain = requestedSubdomain || "";
      let isStarted = false;

      tunnelLogs.set(subdomain, []);

      sshProcess.stdout.on("data", (data) => {
        const output = data.toString();
        
        if (!isStarted && output.includes("https://")) {
          const match = output.match(/https:\/\/([^.]+)\./);
          if (match && match[1]) {
            subdomain = match[1];
            activeTunnels.set(subdomain, sshProcess);
            tunnelLogs.set(subdomain, []);
            isStarted = true;
            
            resolve({
              content: [
                {
                  type: "text",
                  text: `Tunnel started successfully!\nURL: https://${subdomain}.${domain}\nLocal Port: ${port}\nUse get_tunnel_logs to see traffic.`,
                },
              ],
            });
          }
        } else if (isStarted) {
          const lines = output.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
          const logs = tunnelLogs.get(subdomain) || [];
          logs.push(...lines);
          if (logs.length > 100) logs.splice(0, logs.length - 100);
          tunnelLogs.set(subdomain, logs);
        }
      });

      sshProcess.stderr.on("data", (data) => {
        console.error(`[SSH Error] ${data.toString()}`);
      });

      sshProcess.on("close", (code) => {
        if (subdomain) {
          activeTunnels.delete(subdomain);
        }
        if (!isStarted) {
          resolve({
            content: [
              {
                type: "text",
                text: `Failed to start tunnel. Process exited with code ${code}`,
              },
            ],
            isError: true,
          });
        }
      });

      setTimeout(() => {
        if (!isStarted) {
          resolve({
            content: [
              {
                type: "text",
                text: `Tunnel process started, but could not verify banner. If you specified a subdomain, it might be active at https://${subdomain}.${domain}`,
              },
            ],
          });
          isStarted = true;
          if (subdomain) activeTunnels.set(subdomain, sshProcess);
        }
      }, 5000);
    });
  }
);

server.registerTool(
  "stop_tunnel",
  {
    description: "Stop an active Tunnelhunt tunnel",
    inputSchema: {
      subdomain: z.string().describe("The subdomain of the tunnel to stop"),
    }
  },
  async ({ subdomain }) => {
    const process = activeTunnels.get(subdomain);
    if (process) {
      process.kill();
      activeTunnels.delete(subdomain);
      tunnelLogs.delete(subdomain);
      return {
        content: [{ type: "text", text: `Tunnel ${subdomain} stopped.` }],
      };
    } else {
      return {
        content: [{ type: "text", text: `No active tunnel found for ${subdomain}.` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "get_tunnel_logs",
  {
    description: "Get the recent HTTP access logs for an active tunnel. Useful for debugging webhooks and API calls.",
    inputSchema: {
      subdomain: z.string().describe("The subdomain of the tunnel"),
    }
  },
  async ({ subdomain }) => {
    const logs = tunnelLogs.get(subdomain);
    if (!logs) {
      return {
        content: [{ type: "text", text: `No logs found or tunnel is not active for ${subdomain}.` }],
      };
    }

    return {
      content: [{ type: "text", text: logs.length > 0 ? logs.join("\n") : "No traffic logs yet." }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tunnelhunt MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
