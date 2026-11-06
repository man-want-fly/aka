// macOS 首发；Windows 子系统属性保留但不影响 macOS 构建。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aka_desktop_lib::run()
}
