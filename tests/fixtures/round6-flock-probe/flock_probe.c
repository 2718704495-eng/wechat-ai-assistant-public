#include <node_api.h>

#include <errno.h>
#include <sys/file.h>
#include <sys/stat.h>

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
  napi_value result;
  napi_value value;
  if (!read_fd(env, info, &fd)) return NULL;
  if (fstat(fd, &identity) != 0) return make_status(env, 0, errno);
  napi_create_object(env, &result);
  napi_get_boolean(env, 1, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_double(env, (double) identity.st_dev, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_double(env, (double) identity.st_ino, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_int32(env, (int) identity.st_mode, &value);
  napi_set_named_property(env, result, "mode", value);
  napi_create_int32(env, (int) identity.st_nlink, &value);
  napi_set_named_property(env, result, "nlink", value);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    { "lockExclusiveNonblocking", NULL, lock_exclusive_nonblocking, NULL, NULL, NULL, napi_default, NULL },
    { "unlock", NULL, unlock_file, NULL, NULL, NULL, napi_default, NULL },
    { "inspect", NULL, inspect_fd, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, 3, descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
