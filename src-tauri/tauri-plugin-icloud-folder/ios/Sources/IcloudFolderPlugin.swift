import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

// iCloud-folder plugin — proof-of-concept for granting Hush durable,
// read/write access to an *arbitrary* user-picked folder on iOS
// (typically an iCloud Drive location).
//
// iOS apps are always sandboxed, so a folder outside the sandbox can
// only be touched through a security-scoped URL handed back by
// UIDocumentPickerViewController. That access dies when the app quits
// unless we persist a *security-scoped bookmark* and re-resolve it on
// the next launch. Tauri's stock dialog/fs plugins do neither (no
// folder picker mode, no bookmark persistence), which is exactly the
// gap this plugin fills.
//
// Flow:
//   1. pickFolder()       -> present the folder picker, start access,
//                            mint a bookmark, return { path, bookmark }.
//   2. (JS persists the bookmark blob, e.g. localStorage / settings.)
//   3. resolveBookmark()  -> on a later launch, resolve the blob back
//                            into a live security-scoped URL and start
//                            access again.
//   4. listDir/readFile/writeFile operate by absolute path while the
//      folder's scope is held — this is what lets the existing Rust
//      std::fs Local Sync code work unchanged on iOS.
//   5. stopAccess()       -> balance the startAccessing call.

class IcloudFolderPlugin: Plugin, UIDocumentPickerDelegate {
  // The pick is async (waits on the picker UI), so we stash the Invoke
  // and resolve it from the delegate callback.
  private var pendingPick: Invoke?

  // Folders we currently hold security-scoped access to, keyed by path,
  // so stopAccess() can balance the matching startAccessing call.
  private var accessing: [String: URL] = [:]

  // MARK: - Pick a folder

  @objc public func pickFolder(_ invoke: Invoke) throws {
    pendingPick = invoke
    DispatchQueue.main.async {
      let picker: UIDocumentPickerViewController
      if #available(iOS 14.0, *) {
        // The key difference from Tauri's stock dialog plugin: we ask
        // for UTType.folder (folder selection) with asCopy:false so we
        // get the real in-place, security-scoped folder URL.
        picker = UIDocumentPickerViewController(
          forOpeningContentTypes: [UTType.folder], asCopy: false)
      } else {
        picker = UIDocumentPickerViewController(
          documentTypes: ["public.folder"], in: .open)
      }
      picker.delegate = self
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen
      self.manager.viewController?.present(picker, animated: true, completion: nil)
    }
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard let invoke = pendingPick else { return }
    pendingPick = nil
    guard let url = urls.first else {
      invoke.reject("No folder selected")
      return
    }
    // Must hold scope before we can read attributes / mint a bookmark.
    let started = url.startAccessingSecurityScopedResource()
    do {
      // On iOS, bookmarks are implicitly security-scoped — there is no
      // .withSecurityScope option (that's macOS-only). A plain
      // bookmarkData() blob is what survives across launches.
      let data = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      accessing[url.path] = url
      invoke.resolve([
        "path": url.path,
        "bookmark": data.base64EncodedString(),
        "name": url.lastPathComponent,
        "accessOk": started,
      ])
    } catch {
      if started { url.stopAccessingSecurityScopedResource() }
      invoke.reject("Failed to create bookmark: \(error.localizedDescription)")
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingPick?.reject("cancelled")
    pendingPick = nil
  }

  // MARK: - Resolve a persisted bookmark (the cross-launch proof)

  @objc public func resolveBookmark(_ invoke: Invoke) throws {
    struct Args: Decodable { let bookmark: String }
    let args = try invoke.parseArgs(Args.self)
    guard let data = Data(base64Encoded: args.bookmark) else {
      invoke.reject("Bookmark is not valid base64")
      return
    }
    var stale = false
    do {
      let url = try URL(
        resolvingBookmarkData: data, options: [], relativeTo: nil,
        bookmarkDataIsStale: &stale)
      let started = url.startAccessingSecurityScopedResource()
      accessing[url.path] = url
      invoke.resolve([
        "path": url.path,
        "name": url.lastPathComponent,
        "stale": stale,
        "accessOk": started,
      ])
    } catch {
      invoke.reject("Failed to resolve bookmark: \(error.localizedDescription)")
    }
  }

  @objc public func stopAccess(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    if let url = accessing.removeValue(forKey: args.path) {
      url.stopAccessingSecurityScopedResource()
    }
    invoke.resolve()
  }

  // MARK: - Live updates (NSMetadataQuery over an iCloud folder)
  //
  // iOS has no filesystem watcher, but iCloud items are indexed by the
  // metadata daemon: an NSMetadataQuery scoped under a folder fires
  // NSMetadataQueryDidUpdate whenever items under it change — including
  // changes synced *in* from another device. Only ubiquitous (iCloud)
  // items are covered; folders from other Files providers stay on the
  // foreground-reconcile fallback.

  private var watchQueries: [String: NSMetadataQuery] = [:]
  private var watchDebounce: [String: DispatchWorkItem] = [:]

  @objc public func startWatch(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    DispatchQueue.main.async {
      if self.watchQueries[args.path] != nil {
        invoke.resolve()
        return
      }
      let query = NSMetadataQuery()
      query.searchScopes = [
        NSMetadataQueryUbiquitousDocumentsScope,
        NSMetadataQueryUbiquitousDataScope,
      ]
      query.predicate = NSPredicate(
        format: "%K BEGINSWITH %@", NSMetadataItemPathKey, args.path + "/")
      // The query batches its own bursts (an iCloud sync pass touches
      // many files); the debounce below folds the remainder.
      query.notificationBatchingInterval = 2.0
      NotificationCenter.default.addObserver(
        self, selector: #selector(self.metadataQueryDidUpdate(_:)),
        name: .NSMetadataQueryDidUpdate, object: query)
      self.watchQueries[args.path] = query
      query.start()
      invoke.resolve()
    }
  }

  @objc public func stopWatch(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    DispatchQueue.main.async {
      if let query = self.watchQueries.removeValue(forKey: args.path) {
        NotificationCenter.default.removeObserver(
          self, name: .NSMetadataQueryDidUpdate, object: query)
        query.stop()
      }
      self.watchDebounce.removeValue(forKey: args.path)?.cancel()
      invoke.resolve()
    }
  }

  @objc private func metadataQueryDidUpdate(_ note: Notification) {
    guard let query = note.object as? NSMetadataQuery else { return }
    guard let path = watchQueries.first(where: { $0.value === query })?.key else { return }
    watchDebounce[path]?.cancel()
    let work = DispatchWorkItem { [weak self] in
      var payload = JSObject()
      payload["path"] = path
      self?.trigger("watch-changed", data: payload)
    }
    watchDebounce[path] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
  }

  // MARK: - Reveal in the Files app

  /// Open the Files app at `path`. There is no UIKit "reveal" API (the
  /// cross-platform tauri-plugin-opener `revealItemInDir` is a no-op on
  /// iOS); the documented route is the `shareddocuments://` URL scheme
  /// with the raw filesystem path appended. Works for iCloud Drive /
  /// Files-app provider folders the user has already granted access to.
  @objc public func revealInFiles(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    // Percent-encode the path but keep "/" as path separators.
    let encoded = args.path.addingPercentEncoding(
      withAllowedCharacters: .urlPathAllowed) ?? args.path
    guard let url = URL(string: "shareddocuments://" + encoded) else {
      invoke.reject("Could not build shareddocuments URL")
      return
    }
    DispatchQueue.main.async {
      UIApplication.shared.open(url, options: [:]) { ok in
        if ok {
          invoke.resolve()
        } else {
          invoke.reject("Files app could not open the folder")
        }
      }
    }
  }

  // MARK: - File operations inside the scoped folder

  @objc public func listDir(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let dir = URL(fileURLWithPath: args.path, isDirectory: true)
    do {
      let items = try FileManager.default.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles])
      var entries: [[String: Any]] = []
      for item in items {
        let isDir =
          (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        entries.append(["name": item.lastPathComponent, "isDir": isDir])
      }
      invoke.resolve(["entries": entries])
    } catch {
      invoke.reject("listDir failed: \(error.localizedDescription)")
    }
  }

  @objc public func readFile(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    // iCloud files can be dataless placeholders; nudge a download then
    // do a coordinated read so we don't race the iCloud daemon.
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    var coordErr: NSError?
    var contents: String?
    var readErr: Error?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) {
      (u) in
      do { contents = try String(contentsOf: u, encoding: .utf8) } catch { readErr = error }
    }
    if let c = contents {
      invoke.resolve(["contents": c])
    } else {
      invoke.reject(
        "read failed: "
          + (readErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  @objc public func writeFile(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let contents: String
    }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    var coordErr: NSError?
    var writeErr: Error?
    NSFileCoordinator().coordinate(
      writingItemAt: url, options: .forReplacing, error: &coordErr
    ) { (u) in
      do {
        try args.contents.write(to: u, atomically: true, encoding: .utf8)
      } catch {
        writeErr = error
      }
    }
    if writeErr == nil && coordErr == nil {
      invoke.resolve()
    } else {
      invoke.reject(
        "write failed: "
          + (writeErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  // MARK: - Binary file I/O (images that live beside a .md)

  @objc public func readFileBytes(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    var coordErr: NSError?
    var data: Data?
    var readErr: Error?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { (u) in
      do { data = try Data(contentsOf: u) } catch { readErr = error }
    }
    if let d = data {
      // Hand bytes to JS as base64 — Tauri's bridge balks at large raw
      // byte arrays, and the JS side already base64-decodes for data URLs.
      invoke.resolve(["base64": d.base64EncodedString()])
    } else {
      invoke.reject(
        "read failed: "
          + (readErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  @objc public func writeFileBytes(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let base64: String
      let overwrite: Bool?
    }
    let args = try invoke.parseArgs(Args.self)
    guard let data = Data(base64Encoded: args.base64) else {
      invoke.reject("payload is not valid base64")
      return
    }
    // overwrite=true keeps the exact path (notebook autosave); otherwise
    // collision-suffix so a dropped image never clobbers a sibling.
    let target = (args.overwrite ?? false)
      ? URL(fileURLWithPath: args.path)
      : uniquePath(URL(fileURLWithPath: args.path))
    // Ensure the parent directory exists (dropped images can land in a
    // subfolder of the mount).
    try? FileManager.default.createDirectory(
      at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordErr: NSError?
    var writeErr: Error?
    NSFileCoordinator().coordinate(
      writingItemAt: target, options: .forReplacing, error: &coordErr
    ) { (u) in
      do { try data.write(to: u, options: .atomic) } catch { writeErr = error }
    }
    if writeErr == nil && coordErr == nil {
      // Return the actual filename written so JS can build a matching ref.
      invoke.resolve(["name": target.lastPathComponent])
    } else {
      invoke.reject(
        "write failed: "
          + (writeErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  // MARK: - Mutating operations (create / rename / delete / move / copy)

  @objc public func createFile(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let contents: String
    }
    let args = try invoke.parseArgs(Args.self)
    let target = uniquePath(URL(fileURLWithPath: args.path))
    try? FileManager.default.createDirectory(
      at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordErr: NSError?
    var writeErr: Error?
    NSFileCoordinator().coordinate(
      writingItemAt: target, options: .forReplacing, error: &coordErr
    ) { (u) in
      do { try args.contents.write(to: u, atomically: true, encoding: .utf8) } catch { writeErr = error }
    }
    if writeErr == nil && coordErr == nil {
      invoke.resolve(["path": target.path])
    } else {
      invoke.reject(
        "createFile failed: "
          + (writeErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  @objc public func createDir(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let target = uniqueDirPath(URL(fileURLWithPath: args.path, isDirectory: true))
    do {
      try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
      invoke.resolve(["path": target.path])
    } catch {
      invoke.reject("createDir failed: \(error.localizedDescription)")
    }
  }

  @objc public func renameEntry(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let newName: String
    }
    let args = try invoke.parseArgs(Args.self)
    if args.newName.contains("/") || args.newName.isEmpty {
      invoke.reject("Invalid name")
      return
    }
    let src = URL(fileURLWithPath: args.path)
    let isDir = (try? src.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
    let dest = src.deletingLastPathComponent().appendingPathComponent(args.newName)
    if dest.path == src.path {
      invoke.resolve(["path": src.path])
      return
    }
    let finalDest = isDir ? uniqueDirPath(dest) : uniquePath(dest)
    do {
      try FileManager.default.moveItem(at: src, to: finalDest)
      invoke.resolve(["path": finalDest.path])
    } catch {
      invoke.reject("rename failed: \(error.localizedDescription)")
    }
  }

  @objc public func deleteEntry(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    do {
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
      invoke.resolve()
    } catch {
      invoke.reject("delete failed: \(error.localizedDescription)")
    }
  }

  @objc public func moveEntry(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let srcPath: String
      let dstDir: String
    }
    let args = try invoke.parseArgs(Args.self)
    let src = URL(fileURLWithPath: args.srcPath)
    let isDir = (try? src.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
    let dstDir = URL(fileURLWithPath: args.dstDir, isDirectory: true)
    let dest = dstDir.appendingPathComponent(src.lastPathComponent)
    if dest.path == src.path {
      invoke.resolve(["path": src.path])
      return
    }
    let finalDest = isDir ? uniqueDirPath(dest) : uniquePath(dest)
    do {
      try FileManager.default.moveItem(at: src, to: finalDest)
      invoke.resolve(["path": finalDest.path])
    } catch {
      invoke.reject("move failed: \(error.localizedDescription)")
    }
  }

  @objc public func copyEntry(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let src = URL(fileURLWithPath: args.path)
    let isDir = (try? src.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
    let parent = src.deletingLastPathComponent()
    let ext = src.pathExtension
    let stem = src.deletingPathExtension().lastPathComponent
    let baseName = isDir
      ? "\(src.lastPathComponent)-Copy"
      : (ext.isEmpty ? "\(stem)-Copy" : "\(stem)-Copy.\(ext)")
    let dest = parent.appendingPathComponent(baseName)
    let finalDest = isDir ? uniqueDirPath(dest) : uniquePath(dest)
    do {
      try FileManager.default.copyItem(at: src, to: finalDest)
      invoke.resolve(["path": finalDest.path])
    } catch {
      invoke.reject("copy failed: \(error.localizedDescription)")
    }
  }

  /// Directory-flavoured `uniquePath`: appends " 2", " 3" (no extension
  /// splitting) when a directory of that name already exists.
  private func uniqueDirPath(_ url: URL) -> URL {
    let fm = FileManager.default
    if !fm.fileExists(atPath: url.path) { return url }
    let dir = url.deletingLastPathComponent()
    let name = url.lastPathComponent
    var i = 2
    while i < 10000 {
      let candidate = dir.appendingPathComponent("\(name) \(i)")
      if !fm.fileExists(atPath: candidate.path) { return candidate }
      i += 1
    }
    return url
  }

  /// Append " 2", " 3", … before the extension if `url` already exists.
  /// Mirrors the macOS `unique_path` in local_sync.rs.
  private func uniquePath(_ url: URL) -> URL {
    let fm = FileManager.default
    if !fm.fileExists(atPath: url.path) { return url }
    let dir = url.deletingLastPathComponent()
    let ext = url.pathExtension
    let stem = url.deletingPathExtension().lastPathComponent
    var i = 2
    while i < 10000 {
      let name = ext.isEmpty ? "\(stem) \(i)" : "\(stem) \(i).\(ext)"
      let candidate = dir.appendingPathComponent(name)
      if !fm.fileExists(atPath: candidate.path) { return candidate }
      i += 1
    }
    return url
  }

  /// Pulls every file in a folder down from iCloud.
  ///
  /// An iCloud folder can list entries that have no local data yet: the file
  /// appears as a dot-prefixed `.name.ext.icloud` placeholder, which ordinary
  /// directory reads skip. Nothing outside this plugin can materialise those,
  /// so the app asks for a download and waits for it before syncing.
  @objc public func materializeFolder(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let timeoutMs: Int?
      let suffix: String?
    }
    let args = try invoke.parseArgs(Args.self)
    let dir = URL(fileURLWithPath: args.path, isDirectory: true)
    let deadline = Date().addingTimeInterval(Double(args.timeoutMs ?? 60_000) / 1000.0)
    let wanted = (args.suffix ?? "").lowercased()

    func matches(_ name: String) -> Bool {
      if wanted.isEmpty { return true }
      var n = name.lowercased()
      // ".story.prophet.icloud" is a placeholder for "story.prophet"
      if n.hasSuffix(".icloud") {
        n = String(n.dropLast(7))
        if n.hasPrefix(".") { n = String(n.dropFirst()) }
      }
      return n.hasSuffix(wanted)
    }

    let fm = FileManager.default
    var requested = 0
    var downloaded = 0
    var pending: [URL] = []

    do {
      // No skipsHiddenFiles here: placeholders are hidden by definition.
      let items = try fm.contentsOfDirectory(
        at: dir,
        includingPropertiesForKeys: [.ubiquitousItemDownloadingStatusKey, .isDirectoryKey],
        options: [])
      for item in items {
        guard matches(item.lastPathComponent) else { continue }
        let isDir =
          (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        if isDir { continue }
        let status = (try? item.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?
          .ubiquitousItemDownloadingStatus
        if status == .current {
          downloaded += 1
          continue
        }
        // A placeholder's real name is the path minus the dot and suffix.
        var target = item
        let name = item.lastPathComponent
        if name.hasSuffix(".icloud") && name.hasPrefix(".") {
          let real = String(name.dropFirst().dropLast(7))
          target = dir.appendingPathComponent(real)
        }
        do {
          try fm.startDownloadingUbiquitousItem(at: target)
          requested += 1
          pending.append(target)
        } catch {
          // Not an iCloud item, or already local under another name.
        }
      }
    } catch {
      invoke.reject("materializeFolder failed: \(error.localizedDescription)")
      return
    }

    // Wait for the downloads we asked for, so the caller can read the files
    // immediately afterwards.
    while !pending.isEmpty && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.25)
      pending = pending.filter { url in
        let status = (try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?
          .ubiquitousItemDownloadingStatus
        if status == .current || fm.fileExists(atPath: url.path) {
          downloaded += 1
          return false
        }
        return true
      }
    }

    invoke.resolve([
      "requested": requested,
      "downloaded": downloaded,
      "stillPending": pending.count,
    ])
  }
}

@_cdecl("init_plugin_icloud_folder")
func initPlugin() -> Plugin {
  return IcloudFolderPlugin()
}
