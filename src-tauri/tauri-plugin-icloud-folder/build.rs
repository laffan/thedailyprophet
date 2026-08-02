const COMMANDS: &[&str] = &[
    "pick_folder",
    "resolve_bookmark",
    "stop_access",
    "start_watch",
    "stop_watch",
    "reveal_in_files",
    "list_dir",
    "read_file",
    "write_file",
    "read_file_bytes",
    "write_file_bytes",
    "create_file",
    "create_dir",
    "rename_entry",
    "delete_entry",
    "move_entry",
    "copy_entry",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
