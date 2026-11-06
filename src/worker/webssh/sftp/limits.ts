// W5 SFTP limits. The plan caps a single remote file at 2 GiB and each API read/write block at
// 64 MiB; the wire protocol still uses 64 KiB packets so OpenSSH's sftp-server stays happy.

export const WEBSSH_SFTP_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const WEBSSH_SFTP_MAX_BLOCK_BYTES = 64 * 1024 * 1024
export const WEBSSH_SFTP_WIRE_CHUNK_BYTES = 64 * 1024
export const WEBSSH_SFTP_MAX_PATH_LENGTH = 4096
export const WEBSSH_SFTP_MAX_NAME_LENGTH = 255
export const WEBSSH_SFTP_MAX_DIRECTORY_ENTRIES = 10_000

/** 2 GiB staged in the smallest sensible 64 KiB block; bounds R2 object count per transfer. */
export const WEBSSH_SFTP_MAX_UPLOAD_PARTS = WEBSSH_SFTP_MAX_FILE_BYTES / WEBSSH_SFTP_WIRE_CHUNK_BYTES

/** R2 staging prefix from plan §5.4 (`webssh/{kind}/...`); `documents` is the upload category. */
export const WEBSSH_SFTP_UPLOAD_PREFIX = 'webssh/documents/uploads'
