#include <node_api.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <deque>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <winioctl.h>
#else
#include <cerrno>
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/openat2.h>
#include <sys/syscall.h>
#endif
#endif

namespace secure {
struct Failure : std::runtime_error {
  std::string code;
  int nativeError;
  explicit Failure(std::string value, int native = 0) : std::runtime_error(value), code(std::move(value)), nativeError(native) {}
};

#ifdef _WIN32
using Raw = HANDLE;
const Raw invalid = INVALID_HANDLE_VALUE;
void closeRaw(Raw h) { if (h != invalid && h != nullptr) CloseHandle(h); }
std::wstring wide(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (n == 0 && !s.empty()) throw Failure("invalid_argument");
  std::wstring result(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), result.data(), n);
  return result;
}
std::string utf8(const std::wstring& s) {
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  if (n == 0 && !s.empty()) throw Failure("invalid_argument");
  std::string result(n, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), result.data(), n, nullptr, nullptr);
  return result;
}
[[noreturn]] void osFailure() {
  auto e = GetLastError();
  if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) throw Failure("file_not_found", static_cast<int>(e));
  if (e == ERROR_DIRECTORY) throw Failure("not_a_file", static_cast<int>(e));
  throw Failure("path_outside_root", static_cast<int>(e));
}
Raw duplicate(Raw h) {
  Raw copy;
  if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) osFailure();
  return copy;
}
#else
using Raw = int;
constexpr Raw invalid = -1;
void closeRaw(Raw h) { if (h != invalid) close(h); }
[[noreturn]] void osFailure() {
  if (errno == ENOENT) throw Failure("file_not_found");
  if (errno == ENOTDIR) throw Failure("not_a_file");
  if (errno == ELOOP || errno == EXDEV || errno == EACCES || errno == EPERM || errno == EAGAIN) throw Failure("path_outside_root");
  if (errno == ENXIO || errno == ENODEV) throw Failure("not_a_file");
  throw Failure("internal_error", errno);
}
Raw duplicate(Raw h) {
  int copy = fcntl(h, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) osFailure();
  return copy;
}
#endif

struct Handle {
  Raw value = invalid;
  explicit Handle(Raw h = invalid) : value(h) {}
  ~Handle() { closeRaw(value); }
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, invalid)) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { closeRaw(value); value = std::exchange(other.value, invalid); }
    return *this;
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

struct Info {
  bool directory = false, link = false, regular = false;
  uint64_t size = 0, device = 0, identity = 0, modified = 0, changed = 0;
  double modifiedMs = 0;
};
Info infoOf(Raw h) {
  Info out;
#ifdef _WIN32
  BY_HANDLE_FILE_INFORMATION s;
  FILE_BASIC_INFO basic;
  if (!GetFileInformationByHandle(h, &s) || !GetFileInformationByHandleEx(h, FileBasicInfo, &basic, sizeof(basic))) osFailure();
  out.directory = (s.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  out.link = (s.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  out.regular = GetFileType(h) == FILE_TYPE_DISK && !out.directory && !out.link;
  out.size = (uint64_t(s.nFileSizeHigh) << 32) | s.nFileSizeLow;
  out.device = s.dwVolumeSerialNumber;
  out.identity = (uint64_t(s.nFileIndexHigh) << 32) | s.nFileIndexLow;
  out.modified = basic.LastWriteTime.QuadPart;
  out.changed = basic.ChangeTime.QuadPart;
  out.modifiedMs = static_cast<double>(basic.LastWriteTime.QuadPart - 116444736000000000LL) / 10000.0;
#else
  struct stat s;
  if (fstat(h, &s) != 0) osFailure();
  out.directory = S_ISDIR(s.st_mode);
  out.link = S_ISLNK(s.st_mode);
  out.regular = S_ISREG(s.st_mode);
  out.size = static_cast<uint64_t>(s.st_size);
  out.device = s.st_dev;
  out.identity = s.st_ino;
#ifdef __APPLE__
  auto mt = s.st_mtimespec, ct = s.st_ctimespec;
#else
  auto mt = s.st_mtim, ct = s.st_ctim;
#endif
  out.modified = uint64_t(mt.tv_sec) * 1000000000ULL + mt.tv_nsec;
  out.changed = uint64_t(ct.tv_sec) * 1000000000ULL + ct.tv_nsec;
  out.modifiedMs = static_cast<double>(mt.tv_sec) * 1000.0 + static_cast<double>(mt.tv_nsec) / 1000000.0;
#endif
  return out;
}
bool same(const Info& a, const Info& b) {
  return a.regular == b.regular && a.device == b.device && a.identity == b.identity && a.size == b.size && a.modified == b.modified && a.changed == b.changed;
}

std::string slash(std::string s) {
#ifdef _WIN32
  std::replace(s.begin(), s.end(), '\\', '/');
#endif
  return s;
}
std::deque<std::string> parts(const std::string& input) {
  std::deque<std::string> result;
  const auto s = slash(input);
  size_t start = 0;
  while (start < s.size()) {
    auto end = s.find('/', start);
    if (end == std::string::npos) end = s.size();
    auto part = s.substr(start, end - start);
    if (!part.empty() && part != ".") result.push_back(part);
    start = end + 1;
  }
  return result;
}
std::string joined(const std::vector<std::string>& components) {
  std::string out;
  for (const auto& p : components) { if (!out.empty()) out += '/'; out += p; }
  return out;
}
bool absolute(const std::string& path) {
#ifdef _WIN32
  return !path.empty() && (path.front() == '/' || (path.size() > 1 && path[1] == ':'));
#else
  return !path.empty() && path.front() == '/';
#endif
}
struct Root {
  Handle handle;
  std::string path;
  bool outputOnly = false;
#ifdef _WIN32
  std::deque<std::string> shortNames;
#endif
  explicit Root(const std::string& raw) : path(slash(raw)) {
    while (path.size() > 1 && path.back() == '/') path.pop_back();
#ifdef _WIN32
    handle = Handle(CreateFileW(wide(raw).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (handle.value == invalid) osFailure();
#else
    handle = Handle(open(raw.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
    if (handle.value < 0) osFailure();
#endif
    auto info = infoOf(handle.value);
    if (!info.directory || info.link) throw Failure("not_a_file");
#ifdef _WIN32
    std::vector<wchar_t> spelling(32768);
    auto length = GetShortPathNameW(wide(raw).c_str(), spelling.data(), static_cast<DWORD>(spelling.size()));
    if (length > 0 && length < spelling.size()) shortNames = parts(utf8(std::wstring(spelling.data(), length)));
#endif
  }
  Root(Handle value, std::string raw) : handle(std::move(value)), path(std::move(raw)), outputOnly(true) {}
  std::string relativeTarget(std::string target) const {
    target = slash(std::move(target));
#ifdef _WIN32
    if (target.rfind("/?" "?/UNC/", 0) == 0) target = "//" + target.substr(8);
    else if (target.rfind("/?" "?/", 0) == 0 || target.rfind("//?/", 0) == 0) target = target.substr(4);
#endif
    if (!absolute(target)) return target;
#ifdef _WIN32
    // Compare only aliases captured from the trusted root. Never query an untrusted UNC/device target.
    const auto rootNames = parts(path), targetNames = parts(target);
    if (targetNames.size() < rootNames.size()) throw Failure("path_outside_root");
    auto equalName = [](const std::string& left, const std::string& right) {
      const auto a = wide(left), b = wide(right);
      return CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
    };
    for (size_t i = 0; i < rootNames.size(); ++i) {
      if (!equalName(rootNames[i], targetNames[i]) &&
          (shortNames.size() != rootNames.size() || !equalName(shortNames[i], targetNames[i]))) throw Failure("path_outside_root");
    }
    std::vector<std::string> remaining;
    for (size_t i = rootNames.size(); i < targetNames.size(); ++i) remaining.push_back(targetNames[i]);
    return joined(remaining);
#else
    // Absolute symlink targets may use a configured-root alias (/var vs /private/var).
    // Canonicalization is only a hint: the result is still opened through root-relative handles.
    if (target.compare(0, path.size(), path) != 0) {
      char* canonical = realpath(target.c_str(), nullptr);
      if (!canonical) { if (errno == EINVAL) throw Failure("file_changed"); osFailure(); }
      target = canonical;
      std::free(canonical);
    }
    auto prefix = path;
    auto compare = target;
    if (compare.compare(0, prefix.size(), prefix) != 0) throw Failure("path_outside_root");
    if (target.size() == prefix.size()) return "";
    if (prefix != "/" && target[prefix.size()] != '/') throw Failure("path_outside_root");
    return target.substr(prefix.size() + (prefix == "/" ? 0 : 1));
#endif
  }
};

#ifdef _WIN32
Handle openChild(Raw parent, const std::string& name) {
  if (!name.empty() && (name.find(':') != std::string::npos || name.back() == ' ' || name.back() == '.')) throw Failure("path_outside_root");
  auto w = wide(name);
  if (w.size() > 32767) throw Failure("resource_limit");
  UNICODE_STRING us{ static_cast<USHORT>(w.size() * sizeof(wchar_t)), static_cast<USHORT>(w.size() * sizeof(wchar_t)), w.data() };
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent; attributes.ObjectName = &us; attributes.Attributes = 0x40;
  IO_STATUS_BLOCK status{};
  HANDLE child = invalid;
  using Create = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  static auto create = reinterpret_cast<Create>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (!create) throw Failure("unsupported_platform");
  auto result = create(&child, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes, &status, nullptr, 0,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1,
    0x00200000 | 0x00000020 | 0x00004000 | (name.empty() ? 0x00000001 : 0), nullptr, 0);
  if (result < 0) {
    if (static_cast<ULONG>(result) == 0xC0000034 || static_cast<ULONG>(result) == 0xC000003A) throw Failure("file_not_found");
    throw Failure("path_outside_root", static_cast<int>(result));
  }
  return Handle(child);
}
std::string linkTarget(Raw child) {
  alignas(8) unsigned char data[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
  DWORD length;
  if (!DeviceIoControl(child, FSCTL_GET_REPARSE_POINT, nullptr, 0, data, sizeof(data), &length, nullptr)) osFailure();
  if (length < 16) throw Failure("path_outside_root");
  DWORD tag; USHORT offset, size;
  std::memcpy(&tag, data, 4); std::memcpy(&offset, data + 8, 2); std::memcpy(&size, data + 10, 2);
  size_t base = tag == IO_REPARSE_TAG_SYMLINK ? 20 : tag == IO_REPARSE_TAG_MOUNT_POINT ? 16 : 0;
  if (base == 0 || base + offset + size > length || size % 2 || offset % 2) throw Failure("path_outside_root");
  return utf8(std::wstring(reinterpret_cast<wchar_t*>(data + base + offset), size / 2));
}
#endif

struct Resolved { Handle handle; std::string path; bool viaLink; };
Resolved resolve(const Root& root, const std::string& input) {
  if (absolute(slash(input))) throw Failure("path_outside_root");
  auto pending = parts(input);
  std::vector<Handle> chain;
  std::vector<std::string> names;
  chain.emplace_back(duplicate(root.handle.value));
  size_t links = 0;
  while (!pending.empty()) {
    auto name = pending.front(); pending.pop_front();
    if (name == "..") {
      if (chain.size() == 1) throw Failure("path_outside_root");
      chain.pop_back(); names.pop_back(); continue;
    }
    if (names.size() >= 256) throw Failure("resource_limit");
    bool isLink = false;
    std::string target;
    Handle child;
#ifdef _WIN32
    child = openChild(chain.back().value, name);
    isLink = infoOf(child.value).link;
    if (isLink) target = linkTarget(child.value);
#else
    struct stat s;
    if (fstatat(chain.back().value, name.c_str(), &s, AT_SYMLINK_NOFOLLOW) != 0) osFailure();
    isLink = S_ISLNK(s.st_mode);
    if (isLink) {
      std::vector<char> link(32769);
      auto n = readlinkat(chain.back().value, name.c_str(), link.data(), link.size());
      if (n < 0) { if (errno == EINVAL) throw Failure("file_changed"); osFailure(); }
      if (static_cast<size_t>(n) >= link.size()) throw Failure("resource_limit");
      target.assign(link.data(), static_cast<size_t>(n));
    } else {
      if (!S_ISREG(s.st_mode) && !S_ISDIR(s.st_mode)) throw Failure("not_a_file");
      child = Handle(openat(chain.back().value, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (pending.empty() ? 0 : O_DIRECTORY)));
      if (child.value < 0) osFailure();
    }
#endif
    if (isLink) {
      if (++links > 40) throw Failure("path_outside_root");
      target = slash(target);
      if (absolute(target)) {
        target = root.relativeTarget(target);
        chain.resize(1); names.clear();
      }
      auto expanded = parts(target);
      expanded.insert(expanded.end(), pending.begin(), pending.end());
      pending = std::move(expanded);
      continue;
    }
    auto info = infoOf(child.value);
    if (!info.regular && !info.directory) throw Failure("not_a_file");
    names.push_back(name);
    if (pending.empty()) {
#ifdef __linux__
      // Re-open the resolved components atomically beneath the pinned root. Never fall back on old kernels.
      struct open_how how{};
      how.flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK;
      how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS;
      auto canonical = joined(names);
      Handle atomic(static_cast<int>(syscall(SYS_openat2, root.handle.value, canonical.c_str(), &how, sizeof(how))));
      if (atomic.value < 0) { if (errno == ENOSYS || errno == EINVAL) throw Failure("unsupported_platform"); osFailure(); }
      auto finalInfo = infoOf(atomic.value);
      if (info.device != finalInfo.device || info.identity != finalInfo.identity) throw Failure("file_changed");
      child = std::move(atomic);
#endif
      return {std::move(child), joined(names), links != 0};
    }
    if (!info.directory) throw Failure("not_a_file");
    chain.push_back(std::move(child));
  }
  return {std::move(chain.back()), joined(names), links != 0};
}

class Directory {
#ifdef _WIN32
  Handle handle;
  alignas(8) unsigned char buffer[65536];
  size_t offset = 0;
  bool first = true, refill = true;
#else
  DIR* dir;
#endif
public:
  explicit Directory(Raw h)
#ifdef _WIN32
    // An empty NT relative name reopens this directory with an independent enumeration cursor.
    : handle(openChild(h, "")) {}
#else
    : dir(nullptr) {
      int fd = openat(h, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
      if (fd < 0) osFailure();
      dir = fdopendir(fd);
      if (!dir) { close(fd); osFailure(); }
    }
  ~Directory() { if (dir) closedir(dir); }
#endif
  bool next(std::string& name) {
#ifdef _WIN32
    if (refill) {
      if (!GetFileInformationByHandleEx(handle.value, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer, sizeof(buffer))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) return false;
        osFailure();
      }
      first = false; refill = false; offset = 0;
    }
    auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer + offset);
    if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + entry->FileNameLength > sizeof(buffer)) throw Failure("internal_error");
    name = utf8(std::wstring(entry->FileName, entry->FileNameLength / 2));
    if (entry->NextEntryOffset == 0) refill = true;
    else { offset += entry->NextEntryOffset; if (offset >= sizeof(buffer)) throw Failure("internal_error"); }
    return true;
#else
    errno = 0;
    auto* entry = readdir(dir);
    if (!entry) { if (errno) osFailure(); return false; }
    name = entry->d_name;
    return true;
#endif
  }
};

constexpr uint32_t sha256Constants[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};
constexpr uint32_t rotate(uint32_t value, unsigned bits) { return (value >> bits) | (value << (32 - bits)); }

/**
 * The value must stay bit-identical to Node's createHash("sha256"): every
 * cursor fingerprint is derived from it (packages/file-core/src/cursor.ts),
 * so a "faster" variant silently invalidates every issued cursor instead of
 * failing loudly.
 */
class Sha256 {
  uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  uint64_t bits = 0;
  unsigned char pending[64] = {};
  size_t held = 0;
  void compress(const unsigned char* input) {
    uint32_t w[64];
    for (unsigned i = 0; i < 16; ++i)
      w[i] = uint32_t(input[i * 4]) << 24 | uint32_t(input[i * 4 + 1]) << 16 | uint32_t(input[i * 4 + 2]) << 8 | uint32_t(input[i * 4 + 3]);
    for (unsigned i = 16; i < 64; ++i) {
      const uint32_t a = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const uint32_t b = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + a + w[i - 7] + b;
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
    for (unsigned i = 0; i < 64; ++i) {
      const uint32_t s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t t1 = h + s1 + choice + sha256Constants[i] + w[i];
      const uint32_t s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + s0 + majority;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
public:
  void update(const unsigned char* data, size_t amount) {
    bits += uint64_t(amount) * 8;
    while (amount > 0) {
      if (held == 0 && amount >= 64) { compress(data); data += 64; amount -= 64; continue; }
      const size_t take = std::min<size_t>(64 - held, amount);
      std::memcpy(pending + held, data, take);
      held += take; data += take; amount -= take;
      if (held == 64) { compress(pending); held = 0; }
    }
  }
  void finish(unsigned char out[32]) {
    const uint64_t total = bits;
    pending[held++] = 0x80;
    if (held > 56) { std::memset(pending + held, 0, 64 - held); compress(pending); held = 0; }
    std::memset(pending + held, 0, 56 - held);
    for (unsigned i = 0; i < 8; ++i) pending[56 + i] = static_cast<unsigned char>(total >> (56 - 8 * i));
    compress(pending);
    for (unsigned i = 0; i < 8; ++i) {
      out[i * 4] = static_cast<unsigned char>(state[i] >> 24);
      out[i * 4 + 1] = static_cast<unsigned char>(state[i] >> 16);
      out[i * 4 + 2] = static_cast<unsigned char>(state[i] >> 8);
      out[i * 4 + 3] = static_cast<unsigned char>(state[i]);
    }
  }
};

struct HostSha256 {
  void* (*create)();
  void (*destroy)(void*);
  const void* (*sha256)();
  int (*init)(void*, const void*, void*);
  int (*update)(void*, const void*, size_t);
  int (*finish)(void*, unsigned char*, unsigned int*);
};
template <typename Function> bool hostSymbol(const char* name, Function& out) {
#ifdef _WIN32
  out = reinterpret_cast<Function>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(nullptr), name)));
#else
  out = reinterpret_cast<Function>(dlsym(RTLD_DEFAULT, name));
#endif
  return out != nullptr;
}
/**
 * Guard: the digest goes through the host Node's own OpenSSL, the code behind
 * createHash("sha256"), so it is bit-identical by construction and runs on the
 * CPU's SHA instructions wherever OpenSSL does. The portable Sha256 measured
 * 4-5x slower on darwin-arm64, which made a digest-checked cache hit slower
 * than re-reading the file. The symbols are looked up at run time, never
 * linked: a host that exports none falls back to Sha256 instead of failing to
 * load or aborting on the first call.
 */
const HostSha256* hostSha256() {
  static const HostSha256* const resolved = []() -> const HostSha256* {
    static HostSha256 api{};
    const bool found = hostSymbol("EVP_MD_CTX_new", api.create) && hostSymbol("EVP_MD_CTX_free", api.destroy)
        && hostSymbol("EVP_sha256", api.sha256) && hostSymbol("EVP_DigestInit_ex", api.init)
        && hostSymbol("EVP_DigestUpdate", api.update) && hostSymbol("EVP_DigestFinal_ex", api.finish);
    return found ? &api : nullptr;
  }();
  return resolved;
}
class Digest {
  const HostSha256* host = hostSha256();
  void* context = nullptr;
  Sha256 portable;
public:
  Digest() {
    if (host == nullptr) return;
    context = host->create();
    if (context != nullptr && host->init(context, host->sha256(), nullptr) != 1) { host->destroy(context); context = nullptr; }
  }
  Digest(const Digest&) = delete;
  Digest& operator=(const Digest&) = delete;
  ~Digest() { if (context != nullptr) host->destroy(context); }
  void update(const unsigned char* data, size_t amount) {
    if (context == nullptr) { portable.update(data, amount); return; }
    if (host->update(context, data, amount) != 1) throw Failure("internal_error");
  }
  void finish(unsigned char out[32]) {
    if (context == nullptr) { portable.finish(out); return; }
    unsigned int length = 0;
    if (host->finish(context, out, &length) != 1 || length != 32) throw Failure("internal_error");
  }
};

struct Entry { std::string path; Info info; };
struct Job {
  napi_env env{}; napi_async_work work{}; napi_deferred deferred{};
  std::shared_ptr<Root> root;
  std::string operation, path, error, reason, temporary;
  int nativeError = 0;
  uint32_t budget = 0, depth = 0, ms = 0, visited = 0, unreadable = 0, offset = 0, length = 0;
  std::vector<unsigned char> bytes;
  std::vector<Entry> entries;
  Info info;
  unsigned char hash[32] = {};
};
constexpr uint64_t maxBudgetBytes = 50ull * 1024 * 1024;
/**
 * The budget field is narrower than the sizes it gates. `Info::size` is
 * uint64_t and every ceiling check compares against `Job::budget`, so the
 * comparison is only free of truncation while the accepted ceiling fits the
 * field. Widening maxBudgetBytes past the field breaks the check silently.
 */
static_assert(maxBudgetBytes <= std::numeric_limits<decltype(Job::budget)>::max(),
              "The byte budget ceiling must fit the budget field width.");
Info openWindow(const Job& job, Raw h) {
  auto before = infoOf(h);
  if (!before.regular) throw Failure("not_a_file");
  if (before.size > job.budget) throw Failure("file_too_large");
  return before;
}
size_t readAt(Raw h, unsigned char* out, size_t amount, uint64_t at) {
  size_t done = 0;
  while (done < amount) {
    const size_t want = std::min<size_t>(65536, amount - done);
#ifdef _WIN32
    const uint64_t here = at + done;
    OVERLAPPED position{};
    position.Offset = static_cast<DWORD>(here & 0xFFFFFFFFull);
    position.OffsetHigh = static_cast<DWORD>(here >> 32);
    DWORD n = 0;
    if (!ReadFile(h, out + done, static_cast<DWORD>(want), &n, &position)) {
      if (GetLastError() == ERROR_HANDLE_EOF) return done;
      osFailure();
    }
#else
    auto n = pread(h, out + done, want, static_cast<off_t>(at + done));
    if (n < 0) { if (errno == EINTR) continue; osFailure(); }
#endif
    if (n == 0) return done;
    done += static_cast<size_t>(n);
  }
  return done;
}
/**
 * Closes the read window the same way for every op: nothing may exist past the
 * size that was measured before the read, and the file must still be the same
 * inode with the same timestamps afterwards. A ranged read repeats this per
 * range instead of trusting the range it was handed.
 */
void closeWindow(Raw h, const Info& before) {
  unsigned char extra;
  if (readAt(h, &extra, 1, before.size) != 0 || !same(before, infoOf(h))) throw Failure("file_changed");
}
void readSnapshot(Job& job, Raw h) {
  const auto before = openWindow(job, h);
  job.bytes.resize(static_cast<size_t>(before.size));
  if (readAt(h, job.bytes.data(), job.bytes.size(), 0) != job.bytes.size()) throw Failure("file_changed");
  closeWindow(h, before);
  job.info = before;
}
void readWindow(Job& job, Raw h) {
  const auto before = openWindow(job, h);
  const uint64_t start = std::min<uint64_t>(job.offset, before.size);
  const uint64_t end = std::min<uint64_t>(start + job.length, before.size);
  job.bytes.resize(static_cast<size_t>(end - start));
  if (readAt(h, job.bytes.data(), job.bytes.size(), start) != job.bytes.size()) throw Failure("file_changed");
  closeWindow(h, before);
  job.offset = static_cast<uint32_t>(start);
  job.info = before;
}
void digestFile(Job& job, Raw h) {
  const auto before = openWindow(job, h);
  Digest hash;
  std::vector<unsigned char> window(65536);
  uint64_t at = 0;
  while (at < before.size) {
    const size_t amount = static_cast<size_t>(std::min<uint64_t>(window.size(), before.size - at));
    if (readAt(h, window.data(), amount, at) != amount) throw Failure("file_changed");
    hash.update(window.data(), amount);
    at += amount;
  }
  hash.finish(job.hash);
  closeWindow(h, before);
  job.info = before;
}
void scan(Job& job, Resolved base) {
  if (!infoOf(base.handle.value).directory) throw Failure("not_a_file");
  struct Frame { std::string path; uint32_t depth; std::unique_ptr<Directory> dir; };
  std::vector<Frame> stack;
  stack.push_back({base.path, 0, std::make_unique<Directory>(base.handle.value)});
  const auto start = std::chrono::steady_clock::now();
  while (!stack.empty()) {
    if (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count() >= job.ms) { job.reason = "time"; break; }
    if (job.visited >= job.budget) { job.reason = "entries"; break; }
    std::string name;
    if (!stack.back().dir->next(name)) { stack.pop_back(); continue; }
    if (name == "." || name == "..") continue;
    ++job.visited;
    const auto path = stack.back().path.empty() ? name : stack.back().path + "/" + name;
    const auto depth = stack.back().depth;
    try {
      auto child = resolve(*job.root, path);
      auto info = infoOf(child.handle.value);
      if (info.directory) {
        job.entries.push_back({path, info});
        if (!child.viaLink) {
          if (depth >= job.depth) { job.reason = "depth"; continue; }
          stack.push_back({path, depth + 1, std::make_unique<Directory>(child.handle.value)});
        }
      } else if (info.regular) job.entries.push_back({path, info});
    } catch (const Failure& e) {
      if (e.code == "unsupported_platform" || e.code == "internal_error") throw;
      ++job.unreadable;
    }
  }
}
bool outputName(const std::string& name) {
  if (name.empty() || name.size() > 120 || !((name[0] >= 'a' && name[0] <= 'z') ||
      (name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= '0' && name[0] <= '9'))) return false;
  return std::all_of(name.begin(), name.end(), [](unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
  });
}
void publishOutput(Job& job) {
  if (!job.root->outputOnly || !outputName(job.path) || job.temporary.size() != 32 ||
      !std::all_of(job.temporary.begin(), job.temporary.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'f') || (c >= '0' && c <= '9');
      })) throw Failure("invalid_argument");
  const auto temporary = ".pending-" + job.temporary;
#ifdef _WIN32
  auto name = wide(temporary);
  UNICODE_STRING us{static_cast<USHORT>(name.size() * sizeof(wchar_t)), static_cast<USHORT>(name.size() * sizeof(wchar_t)), name.data()};
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = job.root->handle.value;
  attributes.ObjectName = &us; attributes.Attributes = 0x40;
  IO_STATUS_BLOCK status{};
  HANDLE raw = invalid;
  using Create = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  auto create = reinterpret_cast<Create>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  using Set = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
  auto set = reinterpret_cast<Set>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
  if (!create || !set) throw Failure("unsupported_platform");
  const auto created = create(&raw, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
    &attributes, &status, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, 2,
    0x00200000 | 0x00000020 | 0x00000040, nullptr, 0);
  if (created < 0) throw Failure("internal_error", static_cast<int>(created));
  Handle file(raw);
  bool published = false;
  try {
    size_t done = 0;
    while (done < job.bytes.size()) {
      DWORD written = 0;
      const auto amount = static_cast<DWORD>(std::min<size_t>(65536, job.bytes.size() - done));
      if (!WriteFile(file.value, job.bytes.data() + done, amount, &written, nullptr) || written == 0) osFailure();
      done += written;
    }
    if (!FlushFileBuffers(file.value)) osFailure();
    auto finalName = wide(job.path);
    std::vector<unsigned char> storage(sizeof(FILE_RENAME_INFO) + finalName.size() * sizeof(wchar_t));
    auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    rename->ReplaceIfExists = FALSE; rename->RootDirectory = job.root->handle.value;
    rename->FileNameLength = static_cast<DWORD>(finalName.size() * sizeof(wchar_t));
    std::memcpy(rename->FileName, finalName.data(), rename->FileNameLength);
    /**
     * Guard: NtSetInformationFile resolves the simple target name against the
     * retained directory handle; publication must never re-open its pathname.
     */
    const auto renamed = set(file.value, &status, rename, static_cast<ULONG>(storage.size()), FileRenameInformation);
    if (renamed < 0) {
      if (static_cast<ULONG>(renamed) == 0xC0000035) throw Failure("output_exists");
      throw Failure("internal_error", static_cast<int>(renamed));
    }
    published = true;
  } catch (...) {
    if (!published) { FILE_DISPOSITION_INFO dispose{TRUE}; SetFileInformationByHandle(file.value, FileDispositionInfo, &dispose, sizeof(dispose)); }
    throw;
  }
#else
  Handle file(openat(job.root->handle.value, temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
  if (file.value == invalid) osFailure();
  try {
    size_t done = 0;
    while (done < job.bytes.size()) {
      const auto amount = std::min<size_t>(65536, job.bytes.size() - done);
      const auto written = write(file.value, job.bytes.data() + done, amount);
      if (written < 0) { if (errno == EINTR) continue; osFailure(); }
      if (written == 0) throw Failure("internal_error");
      done += static_cast<size_t>(written);
    }
    if (fsync(file.value) != 0) osFailure();
    const auto written = infoOf(file.value);
    struct stat staged;
    if (fstatat(job.root->handle.value, temporary.c_str(), &staged, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(staged.st_mode) || static_cast<uint64_t>(staged.st_dev) != written.device ||
        static_cast<uint64_t>(staged.st_ino) != written.identity) throw Failure("file_changed");
    if (linkat(job.root->handle.value, temporary.c_str(), job.root->handle.value, job.path.c_str(), 0) != 0) {
      if (errno == EEXIST) throw Failure("output_exists");
      osFailure();
    }
    struct stat published;
    if (fstatat(job.root->handle.value, job.path.c_str(), &published, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(published.st_mode) || static_cast<uint64_t>(published.st_dev) != written.device ||
        static_cast<uint64_t>(published.st_ino) != written.identity) throw Failure("file_changed");
  } catch (...) {
    unlinkat(job.root->handle.value, temporary.c_str(), 0);
    throw;
  }
  unlinkat(job.root->handle.value, temporary.c_str(), 0);
#endif
}
void execute(napi_env, void* data) {
  auto& job = *static_cast<Job*>(data);
  try {
    if (job.operation == "publish") { publishOutput(job); return; }
    if (job.root->outputOnly) throw Failure("invalid_argument");
    auto opened = resolve(*job.root, job.path);
    if (job.operation == "read") readSnapshot(job, opened.handle.value);
    else if (job.operation == "readRange") readWindow(job, opened.handle.value);
    else if (job.operation == "digest") digestFile(job, opened.handle.value);
    else if (job.operation == "scan") scan(job, std::move(opened));
    else if (job.operation == "resolve") job.path = opened.path;
    else throw Failure("invalid_argument");
  } catch (const Failure& error) { job.error = error.code; job.nativeError = error.nativeError; }
  catch (...) { job.error = "internal_error"; }
}
napi_value string(napi_env env, const std::string& value) {
  napi_value out; napi_create_string_utf8(env, value.data(), value.size(), &out); return out;
}
void prop(napi_env env, napi_value object, const char* name, napi_value value) { napi_set_named_property(env, object, name, value); }
void number(napi_env env, napi_value object, const char* name, double value) { napi_value n; napi_create_double(env, value, &n); prop(env, object, name, n); }
napi_value errorValue(napi_env env, const std::string& code) {
  napi_value error; napi_create_error(env, nullptr, string(env, "Secure filesystem operation failed."), &error); prop(env, error, "code", string(env, code)); return error;
}
/**
 * Hands the snapshot vector to JavaScript without a second file-sized copy.
 *
 * Guard: only napi_no_external_buffers_allowed (V8 sandbox builds such as
 * Electron) is known to return before Node takes the finalizer; there the
 * vector is still ours and is copied. Node may already have run the finalizer
 * on any other failure, so the vector is neither copied nor freed there:
 * touching it could be a use-after-free and deleting it a double free.
 */
bool bytesValue(napi_env env, std::vector<unsigned char>& bytes, napi_value* out) {
  if (bytes.empty()) return napi_create_buffer_copy(env, 0, nullptr, nullptr, out) == napi_ok;
  auto* owned = new std::vector<unsigned char>(std::move(bytes));
  const auto status = napi_create_external_buffer(env, owned->size(), owned->data(),
      [](napi_env, void*, void* hint) { delete static_cast<std::vector<unsigned char>*>(hint); }, owned, out);
  if (status == napi_ok) return true;
  if (status != napi_no_external_buffers_allowed) return false;
  const bool copied = napi_create_buffer_copy(env, owned->size(), owned->data(), nullptr, out) == napi_ok;
  delete owned;
  return copied;
}
void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Job> job(static_cast<Job*>(data));
  if (status != napi_ok && job->error.empty()) job->error = "internal_error";
  napi_value bytes = nullptr;
  if (job->error.empty() && (job->operation == "read" || job->operation == "readRange") && !bytesValue(env, job->bytes, &bytes))
    job->error = "internal_error";
  if (!job->error.empty()) {
    auto error = errorValue(env, job->error);
    number(env, error, "nativeError", job->nativeError);
    napi_reject_deferred(env, job->deferred, error);
  }
  else {
    napi_value result;
    if (job->operation == "resolve" || job->operation == "publish") result = string(env, job->path);
    else {
      napi_create_object(env, &result);
      if (job->operation == "read" || job->operation == "readRange") {
        prop(env, result, "bytes", bytes); number(env, result, "size", static_cast<double>(job->info.size)); number(env, result, "modifiedMs", job->info.modifiedMs);
        if (job->operation == "readRange") number(env, result, "offset", static_cast<double>(job->offset));
      } else if (job->operation == "digest") {
        napi_value buffer;
        napi_create_buffer_copy(env, sizeof(job->hash), job->hash, nullptr, &buffer);
        prop(env, result, "digest", buffer); number(env, result, "size", static_cast<double>(job->info.size)); number(env, result, "modifiedMs", job->info.modifiedMs);
      } else {
        napi_value array; napi_create_array_with_length(env, job->entries.size(), &array);
        for (size_t i = 0; i < job->entries.size(); ++i) {
          napi_value entry, directory; napi_create_object(env, &entry);
          prop(env, entry, "path", string(env, job->entries[i].path));
          number(env, entry, "size", static_cast<double>(job->entries[i].info.size)); number(env, entry, "modifiedMs", job->entries[i].info.modifiedMs);
          napi_get_boolean(env, job->entries[i].info.directory, &directory); prop(env, entry, "directory", directory);
          napi_set_element(env, array, static_cast<uint32_t>(i), entry);
        }
        prop(env, result, "entries", array); number(env, result, "visited", job->visited); number(env, result, "unreadable", job->unreadable);
        napi_value reason; if (job->reason.empty()) napi_get_null(env, &reason); else reason = string(env, job->reason); prop(env, result, "reason", reason);
      }
    }
    napi_resolve_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
}
std::string argument(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 131072) throw Failure("invalid_argument");
  std::vector<char> buffer(length + 1);
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  std::string result(buffer.data(), length);
  if (result.find('\0') != std::string::npos) throw Failure("invalid_argument");
  return result;
}
napi_value openRoot(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 1) throw Failure("invalid_argument");
    auto root = std::make_unique<std::shared_ptr<Root>>(std::make_shared<Root>(argument(env, argv[0])));
    napi_value out;
    napi_create_external(env, root.get(), [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<Root>*>(data); }, nullptr, &out);
    root.release(); return out;
  } catch (const Failure& error) { napi_throw(env, errorValue(env, error.code)); }
  catch (...) { napi_throw(env, errorValue(env, "internal_error")); }
  return nullptr;
}
napi_value run(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 8; napi_value argv[8]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 8) throw Failure("invalid_argument");
    void* ptr;
    if (napi_get_value_external(env, argv[0], &ptr) != napi_ok || !ptr) throw Failure("invalid_argument");
    auto job = std::make_unique<Job>();
    job->env = env; job->root = *static_cast<std::shared_ptr<Root>*>(ptr);
    job->operation = argument(env, argv[1]); job->path = argument(env, argv[2]);
    if (napi_get_value_uint32(env, argv[3], &job->budget) != napi_ok || napi_get_value_uint32(env, argv[4], &job->depth) != napi_ok || napi_get_value_uint32(env, argv[5], &job->ms) != napi_ok
        || napi_get_value_uint32(env, argv[6], &job->offset) != napi_ok || napi_get_value_uint32(env, argv[7], &job->length) != napi_ok) throw Failure("invalid_argument");
    if (job->budget > maxBudgetBytes || job->depth > 64 || job->ms > 1000 || job->offset > maxBudgetBytes || job->length > maxBudgetBytes
        || (job->operation == "scan" && job->budget > 5000)) throw Failure("invalid_argument");
    napi_value promise; napi_create_promise(env, &job->deferred, &promise);
    napi_create_async_work(env, nullptr, string(env, "secure-filesystem"), execute, complete, job.get(), &job->work);
    napi_queue_async_work(env, job->work); job.release(); return promise;
  } catch (const Failure& error) { napi_throw(env, errorValue(env, error.code)); }
  catch (...) { napi_throw(env, errorValue(env, "internal_error")); }
  return nullptr;
}
napi_value openOutputRoot(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 2) throw Failure("invalid_argument");
    void* pointer;
    if (napi_get_value_external(env, argv[0], &pointer) != napi_ok || !pointer) throw Failure("invalid_argument");
    const auto root = *static_cast<std::shared_ptr<Root>*>(pointer);
    if (root->outputOnly) throw Failure("invalid_argument");
    const auto path = argument(env, argv[1]);
    if (path.empty() || absolute(path)) throw Failure("invalid_argument");
    auto opened = resolve(*root, path);
    if (!infoOf(opened.handle.value).directory) throw Failure("not_a_file");
    auto output = std::make_shared<Root>(std::move(opened.handle), root->path + "/" + opened.path);
    auto owned = std::make_unique<std::shared_ptr<Root>>(std::move(output));
    napi_value out;
    napi_create_external(env, owned.get(), [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<Root>*>(data); }, nullptr, &out);
    owned.release(); return out;
  } catch (const Failure& error) { napi_throw(env, errorValue(env, error.code)); }
  catch (...) { napi_throw(env, errorValue(env, "internal_error")); }
  return nullptr;
}
napi_value publish(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 5; napi_value argv[5]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 5) throw Failure("invalid_argument");
    void* root; void* bytes; size_t length;
    bool buffer = false;
    if (napi_get_value_external(env, argv[0], &root) != napi_ok || !root ||
        napi_is_buffer(env, argv[3], &buffer) != napi_ok || !buffer ||
        napi_get_buffer_info(env, argv[3], &bytes, &length) != napi_ok) throw Failure("invalid_argument");
    auto job = std::make_unique<Job>();
    job->env = env; job->root = *static_cast<std::shared_ptr<Root>*>(root);
    if (!job->root->outputOnly || napi_get_value_uint32(env, argv[4], &job->budget) != napi_ok ||
        job->budget > maxBudgetBytes) throw Failure("invalid_argument");
    if (length > job->budget) throw Failure("file_too_large");
    job->operation = "publish"; job->path = argument(env, argv[1]); job->temporary = argument(env, argv[2]);
    if (length != 0) job->bytes.assign(static_cast<unsigned char*>(bytes), static_cast<unsigned char*>(bytes) + length);
    napi_value promise; napi_create_promise(env, &job->deferred, &promise);
    napi_create_async_work(env, nullptr, string(env, "secure-output"), execute, complete, job.get(), &job->work);
    napi_queue_async_work(env, job->work); job.release(); return promise;
  } catch (const Failure& error) { napi_throw(env, errorValue(env, error.code)); }
  catch (...) { napi_throw(env, errorValue(env, "internal_error")); }
  return nullptr;
}
napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "openRoot", NAPI_AUTO_LENGTH, openRoot, nullptr, &fn); prop(env, exports, "openRoot", fn);
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, run, nullptr, &fn); prop(env, exports, "run", fn);
  napi_create_function(env, "openOutputRoot", NAPI_AUTO_LENGTH, openOutputRoot, nullptr, &fn); prop(env, exports, "openOutputRoot", fn);
  napi_create_function(env, "publish", NAPI_AUTO_LENGTH, publish, nullptr, &fn); prop(env, exports, "publish", fn);
  return exports;
}
}  // namespace secure
NAPI_MODULE(NODE_GYP_MODULE_NAME, secure::init)
