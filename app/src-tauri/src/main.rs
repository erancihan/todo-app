// Keep the console window off Windows release builds — the app is a GUI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    daybook_app_lib::run()
}
