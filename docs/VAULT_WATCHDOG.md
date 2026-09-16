# macOS unattended vault download

This optional source-checkout helper is for a large AiArk vault that is already prepared on an external 4 TB GPT/ExFAT disk. It does **not** format, prepare, or erase disks. It is not yet part of the packaged desktop app and does not claim to prevent physical disconnection, a closed-lid sleep, a power outage, or a remote service outage.

The helper installs a user-level macOS LaunchAgent. Every two minutes it verifies the exact mounted disk UUID **and** AiArk identity, checks the public-file manifest, and looks for the matching `aria2c` process. If the process exited and IPv4 access to Hugging Face is available, it builds a new queue containing **only missing or unfinished public files** and resumes them. Completed files are not requeued. If the disk conclusively vanishes or its identity changes, it asks only the matching downloader to stop, so it cannot continue writing to a replacement path on the internal drive. A temporary failure to read disk metadata is reported without stopping a healthy download. Its download command keeps the Mac and disk awake while active, avoids the observed broken IPv6 route, uses moderate parallelism, and retains aria2 control files and SHA-256 checks.

```bash
npm run vault:watch:install   # requires the prepared AIARK disk to be connected
npm run vault:watch:refresh   # update the installed script without loading launchd
npm run vault:watch:restart-fallback # replace the detached watchdog without duplicating it
npm run vault:watch:status    # inspect local watchdog state
npm run vault:watch:pause     # mark paused, send SIGINT, wait for clean aria2 exit
npm run vault:watch:resume    # clear pause marker and resume on the matching disk
```

The pause command must be used **before** unplugging the disk. Once it confirms the download has stopped, eject the disk through Finder or Disk Utility. Reconnect it and use `vault:watch:resume`; never remove the disk while the process is writing. The pause marker remains on the Mac, so the LaunchAgent will not undo a deliberate pause.

The service definition is in `~/Library/LaunchAgents/dev.aiark.vault-watchdog.plist`; its installed script, private configuration, and status are in `~/Library/Application Support/AiArk/VaultWatchdog/`. Re-run `vault:watch:install` after changing the source script when launchd has permission; use `vault:watch:refresh` to update only the installed script while launchd permission is pending, then restart any detached `watch` session to load the new code. Logs are in `~/Library/Logs/AiArk/` and the ark's `.aiark/logs/`. A user LaunchAgent starts after that user logs in; keep the Mac plugged into power and the lid open for uninterrupted overnight downloading. If the disk is absent, different, or the network is unavailable, the service waits without creating a replacement `AIARK` folder on the internal drive.

macOS may ask whether `/usr/local/bin/node` may access removable volumes the first time the background agent starts. The user must approve that system request for unattended checks; the foreground desktop app's existing permission is not automatically inherited by a LaunchAgent. Until approval, the current detached downloader can keep running, but the LaunchAgent cannot verify or restart it. Inspect `vault:watch:status` and its `lastCheckedAt` value to confirm that the agent itself is actually checking.

If that permission prompt is deferred, run `npm run vault:watch:restart-fallback` from the source checkout to start or replace a detached user-session watchdog. It checks every two minutes; the helper uses an interprocess lock so the fallback and LaunchAgent cannot restart the same queue together. Do not use `screen -X quit` alone to replace it: that can leave an orphaned Node worker. The fallback survives terminal closure but not a Mac restart, unlike the LaunchAgent.

The service intentionally reports prolonged lack of file progress as `slow_or_stalled` without killing a potentially valid checksum pass. The separate AiArk monitoring task can inspect and decide whether a controlled restart is warranted. When every public file has its expected size and either no `.aria2` control file remains or aria2 logged its completion, the service stops relaunching the queue; a full checksum audit remains necessary. Gated Hugging Face files are excluded until the account has accepted their licenses and authenticated locally.
