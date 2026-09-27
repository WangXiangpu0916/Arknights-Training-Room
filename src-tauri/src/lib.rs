pub mod domain;
pub mod network;
pub mod platform;
pub mod resources;
pub mod service;
pub mod storage;
pub mod updater;

pub type Result<T> = std::result::Result<T, String>;
