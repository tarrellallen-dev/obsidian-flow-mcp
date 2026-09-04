# Running the Obsidian Flow MCP server on Windows

The AddOn runs inside NinjaTrader. The server is a small Node process that reads the AddOn's
named pipe and answers an MCP client. Both live on the same Windows machine; the pipe is
local-only and is never exposed to a network.

Do these once, in order.

## 1. Node

Node 20 or newer. Check first - you may already have it:

```powershell
node -v
npm -v
```

If `node -v` prints v20 or higher, skip to step 2.

Otherwise:

```powershell
winget install OpenJS.NodeJS.LTS
```

If winget reports `Failed when searching source: msstore` with a certificate error, that is the
Microsoft Store source being unreachable, not a problem with the package. Name the source
explicitly:

```powershell
winget install OpenJS.NodeJS.LTS --source winget
```

If winget is unavailable altogether, download the LTS **Windows Installer (.msi)** from nodejs.org
and run it with the default options.

Either way, close PowerShell and open a new window before checking `node -v` again - the installer
edits PATH and an already-open window will not see it.

## 2. If PowerShell refuses to run npm

A default Windows install blocks PowerShell scripts, and npm ships as one. The symptom:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts
is disabled on this system.
```

Node is fine; this is a shell policy. Two ways past it.

**Without changing anything**, call the batch shim instead of the PowerShell one - substitute
`npm.cmd` for `npm` in every command below:

```powershell
npm.cmd install
```

`cmd.exe` also runs plain `npm` with no policy involved.

**Or allow local scripts for your account** (no administrator rights required):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

That permits scripts on your own disk while still blocking unsigned ones downloaded from the
internet. It changes a security setting for your user account, so make it a deliberate choice
rather than a reflex.

## 3. Build the server

An ordinary PowerShell window is fine and is preferable to an elevated one: npm needs no
administrator rights, and installing as Administrator can leave `node_modules` owned awkwardly.

```powershell
cd "$env:USERPROFILE\Documents\nt8-the-boy-prodigy-orderflow-mcp\server"
npm install
npm run typecheck
npm test
npm run build
```

`npm install` reaches the public npm registry and takes a minute the first time. `npm test`
should report all tests passing; it runs entirely offline against a local socket and does not
need NinjaTrader.

## 4. Check the pipe exists

Start NinjaTrader, connect a data feed, and open **New > Obsidian Flow MCP** from the Control
Center. The AddOn creates its pipe when the engine starts. In PowerShell:

```powershell
[System.IO.Directory]::GetFiles("\\.\pipe\") | Select-String "obsidian"
```

A line ending in `obsidian-flow-mcp-v1` means the AddOn is listening. Nothing printed means the
AddOn is not running, or is running under a different pipe name - check `pipeName` in
`Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json` and the status window.

The `instruments` list in that file must name instruments the connected feed actually provides.
A bare futures root is resolved to the front contract and rolled automatically - but name the
type as well, `ES:Future`, because NinjaTrader's database also holds an equity called ES and
`GetInstrument("ES")` returns that one. A hint that disagrees with what NinjaTrader returns is
reported as unresolved rather than guessed at.

A fully qualified name is used exactly as typed; a fully qualified name with a contract month is used exactly as typed, so an
expired contract typed that way produces a connected pipe with no market data, which the status
window's "Resolved as" row marks as EXPIRED and the events-drained row shows as zero. See
`addon/README.md`, "Instrument names", for the three accepted shapes.

## 5. Point an MCP client at it

For your MCP client, edit its MCP server configuration file:

```json
{
  "mcpServers": {
    "obsidian-flow-mcp": {
      "command": "node",
      "args": [
        "C:\\Users\\<you>\\Documents\\nt8-the-boy-prodigy-orderflow-mcp\\server\\dist\\src\\index.js"
      ]
    }
  }
}
```

Use the real path, with doubled backslashes, and restart the app. The server appears under the
name `obsidian-flow-mcp`. Any MCP client that can launch a stdio server works the same way; the
command is `node <path to dist/src/index.js>`.

The server starts even when NinjaTrader is closed: it reports the link as down and keeps
retrying, so the client never has to be restarted because the platform was.

## 6. First calls

- `health` - link state, staleness, dropped events, and the AddOn's push rate.
- `instruments` - what the AddOn announced, with tick size and session template.
- `latency_report` - the AddOn's own in-process handler measurements and the environment block.

If `health` reports the link down while step 3 showed the pipe, the pipe name in the server's
environment (`OF_PIPE_NAME`) and in the AddOn config disagree.

## Notes

- Only one server instance at a time: the AddOn accepts a single pipe client, and a second one
  waits.
- Nothing here needs administrator rights, and the pipe is not reachable from another machine.
- On Linux and macOS the server runs against a Unix socket (`OF_SOCKET_PATH`) for tests and CI
  only. There is no NinjaTrader there, so there is no live data.
