import { Plugin, TFile } from "obsidian";
import { getAPI, LocalRestApiPublicApi } from "obsidian-local-rest-api";

export default class ObsidianLocalRESTAPISamplePlugin extends Plugin {
	private api: LocalRestApiPublicApi;

	registerRoutes() {
		// Here is how you register your routes:
		//
		// 1. Get an API handle:
		this.api = getAPI(this.app, this.manifest);

		// 2. Add your routes -- `addRoute` returns a route object
		//    https://www.geeksforgeeks.org/express-js-router-route-function/
		//    that you can attach handlers to
		this.api.addRoute("/second-brain-mcp/")
			.get((request, response) => {
				response.status(200).json({
					mcp_server: "second-brain-mcp",
					status: "running",
					transport: "Streamable HTTP (stateless)"
				});
			})
			.post(async (request, response) => {
				try {
					let body = request.body;
					if (typeof body === "string") {
						body = JSON.parse(body);
					} else if (Buffer.isBuffer(body)) {
						body = JSON.parse(body.toString("utf-8"));
					}

					if (!body || typeof body !== "object") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32700,
								message: "Parse error"
							},
							id: null
						});
					}

					const { jsonrpc, method, params, id } = body;

					if (jsonrpc !== "2.0") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32600,
								message: "Invalid Request: expected jsonrpc: '2.0'"
							},
							id: id || null
						});
					}

					switch (method) {
						case "initialize": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									protocolVersion: "2024-11-05",
									capabilities: {
										tools: {}
									},
									serverInfo: {
										name: "second-brain-mcp",
										version: "1.0.0"
									}
								}
							});
						}

						case "notifications/initialized": {
							return response.status(204).end();
						}

						case "tools/list": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									tools: [
										{
											name: "query_wiki",
											description: "Query the second brain / Obsidian wiki",
											inputSchema: {
												type: "object",
												properties: {
													query: {
														type: "string",
														description: "The search query to run against the Obsidian wiki"
													},
													parent_limit: {
														type: "integer",
														description: "Maximum number of files that should be included from the search (default: 5, -1 for unlimited)"
													},
													child_limit: {
														type: "integer",
														description: "Maximum number of bidirectional connections to include per file (default: 2, -1 for unlimited)"
													}
												},
												required: ["query"]
											}
										}
									]
								}
							});
						}

						case "tools/call": {
							if (!params || typeof params !== "object" || params.name !== "query_wiki") {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32601,
										message: `Method not found: ${params?.name || method}`
									},
									id: id
								});
							}

							const query = params.arguments?.query;
							const parent_limit = typeof params.arguments?.parent_limit === "number" ? params.arguments.parent_limit : 5;
							const child_limit = typeof params.arguments?.child_limit === "number" ? params.arguments.child_limit : 2;

							if (typeof query !== "string") {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32602,
										message: "Invalid params: query must be a string"
									},
									id: id
								});
							}

							const queryLower = query.toLowerCase();
							const allFiles = this.app.vault.getMarkdownFiles();
							
							interface SearchResultItem {
								path: string;
								content: string;
								connections: { path: string; content: string }[];
							}
							
							const matchedFiles: SearchResultItem[] = [];

							for (const file of allFiles) {
								if (parent_limit !== -1 && matchedFiles.length >= parent_limit) {
									break;
								}

								const normalizedPath = file.path.replace(/\\/g, "/");
								const normalizedPathLower = normalizedPath.toLowerCase();

								if (!normalizedPathLower.startsWith("wiki/")) {
									continue;
								}

								if (normalizedPathLower === "wiki/index.md" || normalizedPathLower === "wiki/log.md") {
									continue;
								}

								const fileContent = await this.app.vault.cachedRead(file);

								if (
									normalizedPathLower.includes(queryLower) ||
									fileContent.toLowerCase().includes(queryLower)
								) {
									// Gather bidirectional links for this file
									const resolvedLinks = this.app.metadataCache.resolvedLinks;
									const parentPath = file.path;
									
									// 1. Outgoing links
									const outgoingPaths = Object.keys(resolvedLinks[parentPath] || {});
									
									// 2. Incoming backlinks
									const backlinkPaths: string[] = [];
									for (const [sourcePath, destinations] of Object.entries(resolvedLinks)) {
										if (destinations[parentPath]) {
											backlinkPaths.push(sourcePath);
										}
									}
									
									// 3. Unique set of connection paths
									const uniqueConnPaths = Array.from(new Set([...outgoingPaths, ...backlinkPaths]));
									const connections: { path: string; content: string }[] = [];

									for (const connPath of uniqueConnPaths) {
										if (child_limit !== -1 && connections.length >= child_limit) {
											break;
										}

										const normalizedConnPath = connPath.replace(/\\/g, "/");
										const normalizedConnPathLower = normalizedConnPath.toLowerCase();

										// Apply the same scoping and exclusion to children
										if (!normalizedConnPathLower.startsWith("wiki/")) {
											continue;
										}

										if (normalizedConnPathLower === "wiki/index.md" || normalizedConnPathLower === "wiki/log.md") {
											continue;
										}

										const connFile = this.app.vault.getAbstractFileByPath(connPath);
										if (connFile instanceof TFile) {
											const connContent = await this.app.vault.cachedRead(connFile);
											connections.push({
												path: normalizedConnPath,
												content: connContent
											});
										}
									}

									matchedFiles.push({
										path: normalizedPath,
										content: fileContent,
										connections: connections
									});
								}
							}

							let yamlResult = "";
							for (const item of matchedFiles) {
								yamlResult += `- path: ${item.path}\n`;
								
								const contentLines = item.content.split("\n");
								yamlResult += `  content: |\n`;
								for (const line of contentLines) {
									yamlResult += `    ${line}\n`;
								}

								if (item.connections.length > 0) {
									yamlResult += `  connections:\n`;
									for (const conn of item.connections) {
										yamlResult += `    - path: ${conn.path}\n`;
										const connLines = conn.content.split("\n");
										yamlResult += `      content: |\n`;
										for (const line of connLines) {
											yamlResult += `        ${line}\n`;
										}
									}
								} else {
									yamlResult += `  connections: []\n`;
								}
							}

							if (yamlResult === "") {
								yamlResult = "# No matching files found\n";
							}

							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									content: [
										{
											type: "text",
											text: yamlResult
										}
									]
								}
							});
						}

						case "ping": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {}
							});
						}

						default: {
							if (method.endsWith("/list")) {
								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										[method.split("/")[0]]: []
									}
								});
							}

							return response.status(404).json({
								jsonrpc: "2.0",
								error: {
									code: -32601,
									message: `Method not found: ${method}`
								},
								id: id
							});
						}
					}

				} catch (error) {
					console.error("MCP Server Error:", error);
					return response.status(500).json({
						jsonrpc: "2.0",
						error: {
							code: -32603,
							message: error instanceof Error ? error.message : "Internal error"
						},
						id: null
					});
				}
			});

		// For more insight into what you can put into a route, have
		// a look at the existing routes that are handled by
		// the API itself: https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/requestHandler.ts
	}

	//
	//
	//
	//
	// Everything below this point can be left as it is -- this is just
	// setting up machinery to properly register your routes with
	// Obsidian Local REST API
	//
	//
	//
	//

	async onload() {
		if (this.app.plugins.enabledPlugins.has("obsidian-local-rest-api")) {
			this.registerRoutes();
		}

		this.registerEvent(
			this.app.workspace.on(
				"obsidian-local-rest-api:loaded",
				this.registerRoutes.bind(this)
			)
		);
	}

	onunload() {
		if (this.api) {
			(this.api as any).unregister();
		}
	}
}

declare module "obsidian" {
	interface App {
		plugins: {
			enabledPlugins: Set<string>;
		};
	}
	interface Workspace {
		on(
			name: "obsidian-local-rest-api:loaded",
			callback: () => void,
			ctx?: any
		): EventRef;
	}
}
