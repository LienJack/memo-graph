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
  if (argc != 9) {
    return 64;
  }
#ifdef __APPLE__
  int source_fd;
  int target_fd;
  struct stat source_stat;
  struct stat target_stat;
  uint64_t expected_source_dev;
  uint64_t expected_source_ino;
  uint64_t expected_target_dev;
  uint64_t expected_target_ino;
  int rename_result;
  int rename_errno;

  if (
    strchr(argv[2], '/') != NULL ||
    strchr(argv[4], '/') != NULL ||
    strcmp(argv[2], ".") == 0 ||
    strcmp(argv[2], "..") == 0 ||
    strcmp(argv[4], ".") == 0 ||
    strcmp(argv[4], "..") == 0 ||
    parse_identity(argv[5], &expected_source_dev) != 0 ||
    parse_identity(argv[6], &expected_source_ino) != 0 ||
    parse_identity(argv[7], &expected_target_dev) != 0 ||
    parse_identity(argv[8], &expected_target_ino) != 0
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
    fstat(target_fd, &target_stat) != 0 ||
    (uint64_t)source_stat.st_dev != expected_source_dev ||
    (uint64_t)source_stat.st_ino != expected_source_ino ||
    (uint64_t)target_stat.st_dev != expected_target_dev ||
    (uint64_t)target_stat.st_ino != expected_target_ino
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
  close(target_fd);
  close(source_fd);
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
