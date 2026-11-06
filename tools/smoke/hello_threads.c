#include <pthread.h>
#include <stdio.h>

static int result = 0;

static void *worker(void *arg) {
    result = *(int *)arg * 2;
    return NULL;
}

int main(void) {
    pthread_t t;
    int value = 21;
    if (pthread_create(&t, NULL, worker, &value) != 0) {
        printf("thread create failed\n");
        return 1;
    }
    pthread_join(t, NULL);
    printf("thread ok %d\n", result);
    return result == 42 ? 0 : 2;
}
