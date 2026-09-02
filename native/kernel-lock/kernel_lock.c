#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(KERNEL_LOCK_TEST_INTERLOCK)
#include <signal.h>
#endif

#if defined(__APPLE__)
#include <stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#else
#error "kernel-lock supports Darwin and Linux only"
#endif

static int read_fd(napi_env env, napi_callback_info info, int *fd);

static napi_value make_identity_result(napi_env env, const struct stat *identity) {
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_get_boolean(env, 1, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, 0, &value);
  napi_set_named_property(env, result, "errno", value);
  napi_create_double(env, (double)identity->st_dev, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_double(env, (double)identity->st_ino, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_int32(env, (int)identity->st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_int32(env, (int)identity->st_nlink, &value);
  napi_set_named_property(env, result, "nlink", value);
  napi_create_uint32(env, (uint32_t)identity->st_uid, &value);
  napi_set_named_property(env, result, "uid", value);
  napi_create_double(env, (double)identity->st_size, &value);
  napi_set_named_property(env, result, "size", value);
  return result;
}

static napi_value make_status(napi_env env, int ok, int error_number) {
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_get_boolean(env, ok, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, error_number, &value);
  napi_set_named_property(env, result, "errno", value);
  return result;
}

static int read_name(napi_env env, napi_value value, char *name, size_t capacity) {
  size_t length = capacity;
  if (napi_get_value_string_utf8(env, value, name, capacity, &length) != napi_ok ||
      length == 0 || length >= capacity || strchr(name, '/') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    napi_throw_type_error(env, NULL, "EXPECTED_ENTRY_NAME");
    return 0;
  }
  return 1;
}

static napi_value make_open_result(napi_env env, int fd) {
  struct stat identity;
  napi_value result;
  napi_value value;
  if (fd < 0) return make_status(env, 0, errno);
  if (fstat(fd, &identity) != 0) {
    int saved_errno = errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  result = make_identity_result(env, &identity);
  napi_create_int32(env, fd, &value);
  napi_set_named_property(env, result, "fd", value);
  return result;
}

static napi_value open_directory_at_no_follow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int directory_fd;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name))) {
    if (argc != 2) napi_throw_type_error(env, NULL, "EXPECTED_DIRECTORY_OPEN_ARGUMENTS");
    return NULL;
  }
  return make_open_result(
      env,
      openat(directory_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
}

static napi_value open_file_at_no_follow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int directory_fd;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name))) {
    if (argc != 2) napi_throw_type_error(env, NULL, "EXPECTED_FILE_OPEN_ARGUMENTS");
    return NULL;
  }
  return make_open_result(env, openat(directory_fd, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC));
}

static napi_value open_read_file_at_no_follow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int directory_fd;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name))) {
    if (argc != 2) napi_throw_type_error(env, NULL, "EXPECTED_FILE_OPEN_ARGUMENTS");
    return NULL;
  }
  return make_open_result(env, openat(directory_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
}

static napi_value read_directory_names(napi_env env, napi_callback_info info) {
  int fd;
  napi_value result;
  napi_value value;
  napi_value names;
  if (!read_fd(env, info, &fd)) return NULL;
  int copy = dup(fd);
  if (copy < 0) return make_status(env, 0, errno);
  DIR *directory = fdopendir(copy);
  if (directory == NULL) {
    int saved_errno = errno;
    close(copy);
    return make_status(env, 0, saved_errno);
  }
  napi_create_array(env, &names);
  uint32_t index = 0;
  struct dirent *entry;
  int read_errno = 0;
  while (1) {
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL) {
      read_errno = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, names, index++, name);
  }
  closedir(directory);
  if (read_errno != 0) return make_status(env, 0, read_errno);
  napi_create_object(env, &result);
  napi_get_boolean(env, 1, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, 0, &value);
  napi_set_named_property(env, result, "errno", value);
  napi_set_named_property(env, result, "names", names);
  return result;
}

static napi_value inspect_entry_at_no_follow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int directory_fd;
  char name[256];
  struct stat identity;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name))) {
    if (argc != 2) napi_throw_type_error(env, NULL, "EXPECTED_ENTRY_INSPECT_ARGUMENTS");
    return NULL;
  }
  if (fstatat(directory_fd, name, &identity, AT_SYMLINK_NOFOLLOW) != 0) {
    return make_status(env, 0, errno);
  }
  return make_identity_result(env, &identity);
}

static napi_value read_link_at_no_follow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int directory_fd;
  char name[256];
  char target[4096];
  struct stat before;
  struct stat after;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name))) {
    if (argc != 2) napi_throw_type_error(env, NULL, "EXPECTED_READLINK_ARGUMENTS");
    return NULL;
  }
  if (fstatat(directory_fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    return make_status(env, 0, errno);
  }
  if (!S_ISLNK(before.st_mode)) return make_status(env, 0, EINVAL);
  ssize_t length = readlinkat(directory_fd, name, target, sizeof(target) - 1);
  if (length < 0) return make_status(env, 0, errno);
  target[length] = '\0';
  if (fstatat(directory_fd, name, &after, AT_SYMLINK_NOFOLLOW) != 0 ||
      before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_uid != after.st_uid || before.st_mode != after.st_mode) {
    return make_status(env, 0, ESTALE);
  }
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_get_boolean(env, 1, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, 0, &value);
  napi_set_named_property(env, result, "errno", value);
  napi_create_string_utf8(env, target, (size_t)length, &value);
  napi_set_named_property(env, result, "target", value);
  napi_create_double(env, (double)before.st_dev, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_double(env, (double)before.st_ino, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_int32(env, (int)before.st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_int32(env, (int)before.st_nlink, &value);
  napi_set_named_property(env, result, "nlink", value);
  napi_create_uint32(env, (uint32_t)before.st_uid, &value);
  napi_set_named_property(env, result, "uid", value);
  napi_create_double(env, (double)before.st_size, &value);
  napi_set_named_property(env, result, "size", value);
  return result;
}

static napi_value close_fd(napi_env env, napi_callback_info info) {
  int fd;
  if (!read_fd(env, info, &fd)) return NULL;
  if (close(fd) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value fsync_fd(napi_env env, napi_callback_info info) {
  int fd;
  if (!read_fd(env, info, &fd)) return NULL;
  if (fsync(fd) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value mkdir_at_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int directory_fd;
  int32_t mode;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_get_value_int32(env, argv[2], &mode) != napi_ok || mode < 0 || mode > 0777) {
    if (argc != 3) napi_throw_type_error(env, NULL, "EXPECTED_MKDIR_ARGUMENTS");
    return NULL;
  }
  if (mkdirat(directory_fd, name, (mode_t)mode) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value create_private_directory_at_no_replace(
    napi_env env,
    napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int directory_fd;
  int32_t mode;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_get_value_int32(env, argv[2], &mode) != napi_ok || mode < 0 || mode > 0777) {
    if (argc != 3) napi_throw_type_error(env, NULL, "EXPECTED_PRIVATE_DIRECTORY_ARGUMENTS");
    return NULL;
  }
  if (mkdirat(directory_fd, name, (mode_t)mode) != 0) {
    return make_status(env, 0, errno);
  }
  int fd = openat(
      directory_fd,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return make_status(env, 0, errno);
  struct stat opened;
  struct stat named;
  if (fstat(fd, &opened) != 0 ||
      fstatat(directory_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      opened.st_dev != named.st_dev || opened.st_ino != named.st_ino ||
      opened.st_uid != named.st_uid || !S_ISDIR(opened.st_mode) ||
      !S_ISDIR(named.st_mode)) {
    int saved_errno = errno == 0 ? ESTALE : errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  napi_value result = make_open_result(env, fd);
  napi_value value;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "name", value);
  return result;
}

static napi_value create_file_at_no_replace(
    napi_env env,
    napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int directory_fd;
  int32_t mode;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_get_value_int32(env, argv[2], &mode) != napi_ok || mode < 0 || mode > 0777) {
    if (argc != 3) napi_throw_type_error(env, NULL, "EXPECTED_PRIVATE_FILE_ARGUMENTS");
    return NULL;
  }
  int fd = openat(
      directory_fd,
      name,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      (mode_t)mode);
  if (fd < 0) return make_status(env, 0, errno);
  napi_value result = make_open_result(env, fd);
  napi_value value;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "name", value);
  return result;
}

static napi_value write_file_at_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int directory_fd;
  int32_t mode;
  char name[256];
  bool is_buffer = false;
  void *data = NULL;
  size_t size = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_is_buffer(env, argv[2], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[2], &data, &size) != napi_ok ||
      napi_get_value_int32(env, argv[3], &mode) != napi_ok || mode < 0 || mode > 0777) {
    if (argc != 4) napi_throw_type_error(env, NULL, "EXPECTED_WRITE_ARGUMENTS");
    return NULL;
  }
  int fd = openat(
      directory_fd,
      name,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      (mode_t)mode);
  if (fd < 0) return make_status(env, 0, errno);
  size_t written = 0;
  while (written < size) {
    ssize_t count = write(fd, (const char *)data + written, size - written);
    if (count < 0) {
      int saved_errno = errno;
      close(fd);
      return make_status(env, 0, saved_errno);
    }
    written += (size_t)count;
  }
  if (fsync(fd) != 0) {
    int saved_errno = errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  if (close(fd) != 0) return make_status(env, 0, errno);
  return make_status(env, 1, 0);
}

static napi_value link_at_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int directory_fd;
  char source[256];
  char target[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], source, sizeof(source)) ||
      !read_name(env, argv[2], target, sizeof(target))) {
    if (argc != 3) napi_throw_type_error(env, NULL, "EXPECTED_LINK_ARGUMENTS");
    return NULL;
  }
  if (linkat(directory_fd, source, directory_fd, target, 0) == 0) {
    return make_status(env, 1, 0);
  }
  return make_status(env, 0, errno);
}

static napi_value symlink_at_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int directory_fd;
  char target[4096];
  char name[256];
  size_t target_length = sizeof(target);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      napi_get_value_string_utf8(env, argv[1], target, sizeof(target), &target_length) != napi_ok ||
      target_length == 0 || target_length >= sizeof(target) || target[0] == '/' ||
      !read_name(env, argv[2], name, sizeof(name))) {
    if (argc != 3) napi_throw_type_error(env, NULL, "EXPECTED_SYMLINK_ARGUMENTS");
    return NULL;
  }
  if (symlinkat(target, directory_fd, name) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value chmod_at_expected(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  int directory_fd;
  int32_t mode;
  double expected_dev;
  double expected_ino;
  char name[256];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 6 ||
      napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_get_value_double(env, argv[2], &expected_dev) != napi_ok ||
      napi_get_value_double(env, argv[3], &expected_ino) != napi_ok ||
      napi_get_value_int32(env, argv[4], &mode) != napi_ok || mode < 0 || mode > 0777) {
    if (argc != 6) napi_throw_type_error(env, NULL, "EXPECTED_CHMOD_ARGUMENTS");
    return NULL;
  }
  bool is_directory = false;
  if (napi_get_value_bool(env, argv[5], &is_directory) != napi_ok) {
    napi_throw_type_error(env, NULL, "EXPECTED_CHMOD_ARGUMENTS");
    return NULL;
  }
  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (is_directory ? O_DIRECTORY : 0);
  int fd = openat(directory_fd, name, flags);
  if (fd < 0) return make_status(env, 0, errno);
  struct stat identity;
  if (fstat(fd, &identity) != 0 || (double)identity.st_dev != expected_dev ||
      (double)identity.st_ino != expected_ino) {
    int saved_errno = errno == 0 ? ESTALE : errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  if (fchmod(fd, (mode_t)mode) != 0) {
    int saved_errno = errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  if (fsync(fd) != 0) {
    int saved_errno = errno;
    close(fd);
    return make_status(env, 0, saved_errno);
  }
  if (close(fd) != 0) return make_status(env, 0, errno);
  return make_status(env, 1, 0);
}

static napi_value directory_is_empty(napi_env env, napi_callback_info info) {
  int fd;
  napi_value result;
  napi_value value;
  if (!read_fd(env, info, &fd)) return NULL;
  int copy = dup(fd);
  if (copy < 0) return make_status(env, 0, errno);
  DIR *directory = fdopendir(copy);
  if (directory == NULL) {
    int saved_errno = errno;
    close(copy);
    return make_status(env, 0, saved_errno);
  }
  int empty = 1;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
      empty = 0;
      break;
    }
  }
  int read_errno = errno;
  closedir(directory);
  if (read_errno != 0) return make_status(env, 0, read_errno);
  napi_create_object(env, &result);
  napi_get_boolean(env, 1, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, 0, &value);
  napi_set_named_property(env, result, "errno", value);
  napi_get_boolean(env, empty, &value);
  napi_set_named_property(env, result, "empty", value);
  return result;
}

static int same_entry_identity(const struct stat *expected, const struct stat *observed) {
  return expected->st_dev == observed->st_dev &&
      expected->st_ino == observed->st_ino &&
      expected->st_uid == observed->st_uid &&
      (expected->st_mode & S_IFMT) == (observed->st_mode & S_IFMT);
}

static int revalidate_named_entry_no_follow(
    int parent_fd,
    const char *name,
    const struct stat *expected) {
  struct stat observed;
  if (fstatat(parent_fd, name, &observed, AT_SYMLINK_NOFOLLOW) != 0) return errno;
  return same_entry_identity(expected, &observed) ? 0 : ESTALE;
}

static int remove_private_tree_contents(int directory_fd) {
  if (fchmod(directory_fd, 0700) != 0) return errno;
  int copy = dup(directory_fd);
  if (copy < 0) return errno;
  DIR *directory = fdopendir(copy);
  if (directory == NULL) {
    int saved_errno = errno;
    close(copy);
    return saved_errno;
  }
  int failure = 0;
  struct dirent *entry;
  while (failure == 0) {
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) failure = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat identity;
    if (fstatat(directory_fd, entry->d_name, &identity, AT_SYMLINK_NOFOLLOW) != 0) {
      failure = errno;
      break;
    }
    if (S_ISDIR(identity.st_mode)) {
      int child = openat(
          directory_fd,
          entry->d_name,
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) {
        failure = errno;
        break;
      }
      struct stat opened;
      if (fstat(child, &opened) != 0 || opened.st_dev != identity.st_dev ||
          opened.st_ino != identity.st_ino || opened.st_uid != identity.st_uid) {
        failure = errno == 0 ? ESTALE : errno;
      } else {
        failure = remove_private_tree_contents(child);
      }
      if (failure == 0) {
        struct stat final_opened;
        if (fstat(child, &final_opened) != 0) {
          failure = errno;
        } else if (!same_entry_identity(&opened, &final_opened)) {
          failure = ESTALE;
        } else {
          failure = revalidate_named_entry_no_follow(
              directory_fd,
              entry->d_name,
              &opened);
        }
      }
      if (failure == 0 && unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR) != 0) {
        failure = errno;
      }
      if (close(child) != 0 && failure == 0) failure = errno;
    } else if (S_ISREG(identity.st_mode) || S_ISLNK(identity.st_mode)) {
#if defined(KERNEL_LOCK_TEST_INTERLOCK)
      if (strcmp(entry->d_name, "round10-regular-target") == 0 ||
          strcmp(entry->d_name, "round10-symlink-target") == 0) {
        raise(SIGSTOP);
      }
#endif
      failure = revalidate_named_entry_no_follow(directory_fd, entry->d_name, &identity);
      if (failure == 0 && unlinkat(directory_fd, entry->d_name, 0) != 0) failure = errno;
    } else {
      failure = EINVAL;
    }
  }
  if (closedir(directory) != 0 && failure == 0) failure = errno;
  if (failure == 0 && fsync(directory_fd) != 0) failure = errno;
  return failure;
}

static napi_value remove_private_tree_at_expected(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  int parent_fd;
  char name[256];
  double expected_dev;
  double expected_ino;
  uint32_t expected_uid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 5 ||
      napi_get_value_int32(env, argv[0], &parent_fd) != napi_ok || parent_fd < 0 ||
      !read_name(env, argv[1], name, sizeof(name)) ||
      napi_get_value_double(env, argv[2], &expected_dev) != napi_ok ||
      napi_get_value_double(env, argv[3], &expected_ino) != napi_ok ||
      napi_get_value_uint32(env, argv[4], &expected_uid) != napi_ok) {
    if (argc != 5) napi_throw_type_error(env, NULL, "EXPECTED_PRIVATE_TREE_ARGUMENTS");
    return NULL;
  }
  int root = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) return make_status(env, 0, errno);
  struct stat opened;
  struct stat named;
  int failure = 0;
  if (fstat(root, &opened) != 0 || fstatat(parent_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      (double)opened.st_dev != expected_dev || (double)opened.st_ino != expected_ino ||
      opened.st_uid != expected_uid || named.st_dev != opened.st_dev ||
      named.st_ino != opened.st_ino || named.st_uid != opened.st_uid ||
      !S_ISDIR(opened.st_mode) || !S_ISDIR(named.st_mode)) {
    failure = errno == 0 ? ESTALE : errno;
  }
  if (failure == 0) failure = remove_private_tree_contents(root);
  if (close(root) != 0 && failure == 0) failure = errno;
  if (failure == 0) failure = revalidate_named_entry_no_follow(parent_fd, name, &opened);
  if (failure == 0 && unlinkat(parent_fd, name, AT_REMOVEDIR) != 0) failure = errno;
  if (failure == 0 && fsync(parent_fd) != 0) failure = errno;
  return make_status(env, failure == 0, failure);
}

static int read_fd(napi_env env, napi_callback_info info, int *fd) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "EXPECTED_FILE_DESCRIPTOR");
    return 0;
  }
  if (napi_get_value_int32(env, argv[0], fd) != napi_ok || *fd < 0) {
    napi_throw_type_error(env, NULL, "EXPECTED_FILE_DESCRIPTOR");
    return 0;
  }
  return 1;
}

static napi_value lock_exclusive_nonblocking(napi_env env, napi_callback_info info) {
  int fd;
  if (!read_fd(env, info, &fd)) return NULL;
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value unlock_file(napi_env env, napi_callback_info info) {
  int fd;
  if (!read_fd(env, info, &fd)) return NULL;
  if (flock(fd, LOCK_UN) == 0) return make_status(env, 1, 0);
  return make_status(env, 0, errno);
}

static napi_value inspect_fd(napi_env env, napi_callback_info info) {
  int fd;
  struct stat identity;
  if (!read_fd(env, info, &fd)) return NULL;
  if (fstat(fd, &identity) != 0) return make_status(env, 0, errno);
  return make_identity_result(env, &identity);
}

static int read_archive_arguments(
    napi_env env,
    napi_callback_info info,
    int *old_dir_fd,
    char *old_name,
    size_t old_name_capacity,
    int *archive_dir_fd,
    char *archive_name,
    size_t archive_name_capacity) {
  size_t argc = 4;
  napi_value argv[4];
  size_t old_name_length = old_name_capacity;
  size_t archive_name_length = archive_name_capacity;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4) {
    napi_throw_type_error(env, NULL, "EXPECTED_ARCHIVE_ARGUMENTS");
    return 0;
  }
  if (napi_get_value_int32(env, argv[0], old_dir_fd) != napi_ok || *old_dir_fd < 0 ||
      napi_get_value_int32(env, argv[2], archive_dir_fd) != napi_ok || *archive_dir_fd < 0 ||
      napi_get_value_string_utf8(env, argv[1], old_name, old_name_capacity, &old_name_length) != napi_ok ||
      napi_get_value_string_utf8(
          env,
          argv[3],
          archive_name,
          archive_name_capacity,
          &archive_name_length) != napi_ok ||
      old_name_length == 0 || archive_name_length == 0 ||
      strchr(old_name, '/') != NULL || strchr(archive_name, '/') != NULL ||
      strcmp(old_name, ".") == 0 || strcmp(old_name, "..") == 0 ||
      strcmp(archive_name, ".") == 0 || strcmp(archive_name, "..") == 0) {
    napi_throw_type_error(env, NULL, "EXPECTED_ARCHIVE_ARGUMENTS");
    return 0;
  }
  return 1;
}

static napi_value archive_no_replace(napi_env env, napi_callback_info info) {
  int old_dir_fd;
  int archive_dir_fd;
  char old_name[256];
  char archive_name[256];
  if (!read_archive_arguments(
          env,
          info,
          &old_dir_fd,
          old_name,
          sizeof(old_name),
          &archive_dir_fd,
          archive_name,
          sizeof(archive_name))) {
    return NULL;
  }
#if defined(__APPLE__)
  if (renameatx_np(old_dir_fd, old_name, archive_dir_fd, archive_name, RENAME_EXCL) == 0) {
    return make_status(env, 1, 0);
  }
#elif defined(__linux__)
  if (syscall(
          SYS_renameat2,
          old_dir_fd,
          old_name,
          archive_dir_fd,
          archive_name,
          RENAME_NOREPLACE) == 0) {
    return make_status(env, 1, 0);
  }
#endif
  return make_status(env, 0, errno);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"lockExclusiveNonblocking", NULL, lock_exclusive_nonblocking, NULL, NULL, NULL, napi_default, NULL},
      {"unlock", NULL, unlock_file, NULL, NULL, NULL, napi_default, NULL},
      {"inspect", NULL, inspect_fd, NULL, NULL, NULL, napi_default, NULL},
      {"archiveNoReplace", NULL, archive_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"openDirectoryAtNoFollow", NULL, open_directory_at_no_follow, NULL, NULL, NULL, napi_default, NULL},
      {"openFileAtNoFollow", NULL, open_file_at_no_follow, NULL, NULL, NULL, napi_default, NULL},
      {"openReadFileAtNoFollow", NULL, open_read_file_at_no_follow, NULL, NULL, NULL, napi_default, NULL},
      {"readDirectoryNames", NULL, read_directory_names, NULL, NULL, NULL, napi_default, NULL},
      {"inspectEntryAtNoFollow", NULL, inspect_entry_at_no_follow, NULL, NULL, NULL, napi_default, NULL},
      {"readLinkAtNoFollow", NULL, read_link_at_no_follow, NULL, NULL, NULL, napi_default, NULL},
      {"closeFd", NULL, close_fd, NULL, NULL, NULL, napi_default, NULL},
      {"fsyncFd", NULL, fsync_fd, NULL, NULL, NULL, napi_default, NULL},
      {"mkdirAtNoReplace", NULL, mkdir_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"createPrivateDirectoryAtNoReplace", NULL, create_private_directory_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"createFileAtNoReplace", NULL, create_file_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"writeFileAtNoReplace", NULL, write_file_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"linkAtNoReplace", NULL, link_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"symlinkAtNoReplace", NULL, symlink_at_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"chmodAtExpected", NULL, chmod_at_expected, NULL, NULL, NULL, napi_default, NULL},
      {"directoryIsEmpty", NULL, directory_is_empty, NULL, NULL, NULL, napi_default, NULL},
      {"removePrivateTreeAtExpected", NULL, remove_private_tree_at_expected, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 21, descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
