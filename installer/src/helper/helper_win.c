#include <windows.h>
#include <shellapi.h>
#include <string.h>
#include <stdlib.h>

#define EXIT_SUCCESS 0
#define EXIT_BAD_ARGS 1
#define EXIT_ELEV_FAIL 2
#define EXIT_COPY_FAIL 3

static int is_elevated(void) {
    HANDLE token;
    DWORD size;
    DWORD elevated = 0;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return 0;

    GetTokenInformation(token, TokenElevation, &elevated, sizeof(elevated), &size);
    CloseHandle(token);
    return elevated;
}

static WCHAR *get_dir(const WCHAR *path) {
    const WCHAR *p = path + wcslen(path);
    while (p > path && p[-1] != L'\\' && p[-1] != L'/')
        p--;
    if (p == path)
        return NULL;
    size_t len = (size_t)(p - path);
    WCHAR *dir = (WCHAR *)malloc((len + 1) * sizeof(WCHAR));
    if (!dir)
        return NULL;
    wcsncpy(dir, path, len);
    dir[len] = 0;
    return dir;
}

static int can_write_to(const WCHAR *dst_path) {
    // Walk up from the destination's parent dir to the deepest *existing*
    // ancestor and probe it with a temp file.  The parent dirs of dst may not
    // exist yet, but a missing dir under an admin-protected tree still needs
    // elevation, so "parent missing" must not be treated as "writable".
    // Mirrors the walk-up logic in admin_copy.c (Windows) — keep in sync.
    const WCHAR *p = dst_path + wcslen(dst_path);
    while (p > dst_path && p[-1] != L'\\' && p[-1] != L'/') p--;
    if (p == dst_path) return 0;

    size_t dlen = (size_t)(p - dst_path);
    if (dlen >= MAX_PATH) return 0;
    WCHAR dir[MAX_PATH];
    wcsncpy(dir, dst_path, dlen);
    dir[dlen] = 0;

    for (;;) {
        DWORD attrs = GetFileAttributesW(dir);
        if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            WCHAR test[MAX_PATH];
            wsprintfW(test, L"%s\\__wtest_%08lx.tmp", dir, GetCurrentProcessId());
            HANDLE h = CreateFileW(test, GENERIC_WRITE, 0, NULL,
                                   CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
            if (h != INVALID_HANDLE_VALUE) {
                CloseHandle(h);
                DeleteFileW(test);
                return 1;
            }
            return (GetLastError() != ERROR_ACCESS_DENIED);
        }
        // Strip the last component and retry.
        size_t len = wcslen(dir);
        while (len > 0 && (dir[len - 1] == L'\\' || dir[len - 1] == L'/')) dir[--len] = 0;
        while (len > 0 && dir[len - 1] != L'\\' && dir[len - 1] != L'/') len--;
        dir[len] = 0;
        if (len == 0) break;
    }
    return 1;
}

static WCHAR *make_extended_path(const WCHAR *path) {
    size_t len = wcslen(path);

    // Short paths pass through as-is to avoid \\?\ issues with 8.3 short names.
    // Only use extended-length prefix when path is near MAX_PATH.
    if (len < MAX_PATH - 10)
        return _wcsdup(path);

    if (wcsncmp(path, L"\\\\?\\", 4) == 0)
        return _wcsdup(path);

    if (wcsncmp(path, L"\\\\", 2) == 0) {
        WCHAR *ext = (WCHAR *)malloc((len + 8) * sizeof(WCHAR));
        if (!ext) return NULL;
        wcscpy(ext, L"\\\\?\\UNC\\");
        wcscat(ext, path + 2);
        return ext;
    }

    if (path[0] && path[1] == L':') {
        WCHAR *ext = (WCHAR *)malloc((len + 5) * sizeof(WCHAR));
        if (!ext) return NULL;
        wcscpy(ext, L"\\\\?\\");
        wcscat(ext, path);
        return ext;
    }

    return _wcsdup(path);
}

static void create_dirs_w(const WCHAR *path) {
    WCHAR *tmp = _wcsdup(path);
    if (!tmp) return;

    for (int i = 0; tmp[i]; i++) {
        if (tmp[i] == L'\\' || tmp[i] == L'/') {
            WCHAR saved = tmp[i];
            tmp[i] = 0;
            CreateDirectoryW(tmp, NULL);
            tmp[i] = saved;
        }
    }
    CreateDirectoryW(tmp, NULL);
    free(tmp);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    (void)hInst;
    (void)hPrev;
    (void)lpCmd;
    (void)nShow;

    int argc;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!wargv)
        return EXIT_ELEV_FAIL;

    if (argc < 3 || (argc % 2) == 0) {
        LocalFree(wargv);
        return EXIT_BAD_ARGS;
    }

    LPWSTR exeW = wargv[0];

    int needs_elevation = 0;
    for (int i = 2; i < argc; i += 2) {
        if (!can_write_to(wargv[i])) {
            needs_elevation = 1;
            break;
        }
    }

    if (!is_elevated() && needs_elevation) {
        WCHAR paramsW[4096];
        paramsW[0] = 0;

        for (int i = 1; i < argc; i++) {
            if (i > 1) lstrcatW(paramsW, L" ");
            lstrcatW(paramsW, L"\"");
            lstrcatW(paramsW, wargv[i]);
            lstrcatW(paramsW, L"\"");
        }

        SHELLEXECUTEINFOW sei = { sizeof(sei) };
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = L"runas";
        sei.lpFile = exeW;
        sei.lpParameters = paramsW;
        sei.nShow = SW_SHOWNORMAL;

        if (!ShellExecuteExW(&sei)) {
            LocalFree(wargv);
            return EXIT_ELEV_FAIL;
        }

        WaitForSingleObject(sei.hProcess, INFINITE);
        DWORD exitCode;
        GetExitCodeProcess(sei.hProcess, &exitCode);
        CloseHandle(sei.hProcess);
        LocalFree(wargv);
        return (int)exitCode;
    }

    for (int i = 1; i < argc; i += 2) {
        WCHAR *srcExt = make_extended_path(wargv[i]);
        WCHAR *dstExt = make_extended_path(wargv[i + 1]);
        if (!srcExt || !dstExt) {
            free(srcExt);
            free(dstExt);
            LocalFree(wargv);
            return EXIT_COPY_FAIL;
        }

        WCHAR *dstDir = get_dir(dstExt);
        if (dstDir) {
            create_dirs_w(dstDir);
            free(dstDir);
        }

        BOOL ok = CopyFileW(srcExt, dstExt, FALSE);
        free(srcExt);
        free(dstExt);

        if (!ok) {
            LocalFree(wargv);
            return EXIT_COPY_FAIL;
        }
    }

    LocalFree(wargv);
    return EXIT_SUCCESS;
}