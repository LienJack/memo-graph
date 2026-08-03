#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __APPLE__
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

static int parse_identity(const char *input, uint64_t *output) {
  char *end = NULL;
  unsigned long long value;

  errno = 0;
  value = strtoull(input, &end, 10);
  if (errno != 0 || end == input || *end != '\0') {
    return -1;
  }
  *output = (uint64_t)value;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 17) {
    return 64;
  }
#ifdef __APPLE__
  int source_fd;
  int target_fd;
  struct stat source_stat;
  struct stat source_entry_stat;
  struct stat target_stat;
  uint64_t expected_source_dev;
  uint64_t expected_source_ino;
  uint64_t expected_source_uid;
  uint64_t expected_source_mode;
  uint64_t expected_source_entry_dev;
  uint64_t expected_source_entry_ino;
  uint64_t expected_source_entry_uid;
  uint64_t expected_source_entry_mode;
  uint64_t expected_target_dev;
  uint64_t expected_target_ino;
  uint64_t expected_target_uid;
  uint64_t expected_target_mode;
  int rename_result;
  int rename_errno;
  int sync_errno = 0;

  if (
    strchr(argv[2], '/') != NULL ||
    strchr(argv[4], '/') != NULL ||
    strcmp(argv[2], ".") == 0 ||
    strcmp(argv[2], "..") == 0 ||
    strcmp(argv[4], ".") == 0 ||
    strcmp(argv[4], "..") == 0 ||
    parse_identity(argv[5], &expected_source_dev) != 0 ||
    parse_identity(argv[6], &expected_source_ino) != 0 ||
    parse_identity(argv[7], &expected_source_uid) != 0 ||
    parse_identity(argv[8], &expected_source_mode) != 0 ||
    parse_identity(argv[9], &expected_source_entry_dev) != 0 ||
    parse_identity(argv[10], &expected_source_entry_ino) != 0 ||
    parse_identity(argv[11], &expected_source_entry_uid) != 0 ||
    parse_identity(argv[12], &expected_source_entry_mode) != 0 ||
    parse_identity(argv[13], &expected_target_dev) != 0 ||
    parse_identity(argv[14], &expected_target_ino) != 0 ||
    parse_identity(argv[15], &expected_target_uid) != 0 ||
    parse_identity(argv[16], &expected_target_mode) != 0
  ) {
    return 64;
  }

  source_fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) {
    return 75;
  }
  target_fd = open(argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (target_fd < 0) {
    close(source_fd);
    return 75;
  }
  if (
    fstat(source_fd, &source_stat) != 0 ||
    fstatat(source_fd, argv[2], &source_entry_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
    (uint64_t)source_stat.st_dev != expected_source_dev ||
    (uint64_t)source_stat.st_ino != expected_source_ino ||
    (uint64_t)source_stat.st_uid != expected_source_uid ||
    (uint64_t)source_stat.st_mode != expected_source_mode ||
    (uint64_t)source_entry_stat.st_dev != expected_source_entry_dev ||
    (uint64_t)source_entry_stat.st_ino != expected_source_entry_ino ||
    (uint64_t)source_entry_stat.st_uid != expected_source_entry_uid ||
    (uint64_t)source_entry_stat.st_mode != expected_source_entry_mode ||
    !S_ISDIR(source_entry_stat.st_mode)
  ) {
    close(target_fd);
    close(source_fd);
    return 76;
  }
  if (
    fstat(target_fd, &target_stat) != 0 ||
    (uint64_t)target_stat.st_dev != expected_target_dev ||
    (uint64_t)target_stat.st_ino != expected_target_ino ||
    (uint64_t)target_stat.st_uid != expected_target_uid ||
    (uint64_t)target_stat.st_mode != expected_target_mode
  ) {
    close(target_fd);
    close(source_fd);
    return 75;
  }

  rename_result = renameatx_np(
    source_fd,
    argv[2],
    target_fd,
    argv[4],
    RENAME_EXCL
  );
  rename_errno = errno;
  if (rename_result == 0) {
    if (fsync(target_fd) != 0) {
      sync_errno = errno;
    } else if (
      (source_stat.st_dev != target_stat.st_dev ||
       source_stat.st_ino != target_stat.st_ino) &&
      fsync(source_fd) != 0
    ) {
      sync_errno = errno;
    }
  }
  close(target_fd);
  close(source_fd);
  if (sync_errno != 0) {
    errno = sync_errno;
    return 74;
  }
  errno = rename_errno;
  if (rename_result == 0) {
    return 0;
  }
  if (errno == EEXIST) {
    return 17;
  }
  if (errno == ENOTSUP || errno == EOPNOTSUPP || errno == ENOSYS) {
    return 78;
  }
  return 74;
#else
  (void)argv;
  return 78;
#endif
}
