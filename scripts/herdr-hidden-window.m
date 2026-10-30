// Loaded into a throwaway copy of Herdr by scripts/herdr-hidden-window.sh, so
// the copy draws real frames while the person's front app and keyboard stay put.
// The original app has the hardened runtime and ignores DYLD_INSERT_LIBRARIES.
//
// Built with -DWINDOW_CHECK it is instead a small tool: it prints the alpha and
// layer the window server holds for each window of a pid, one window per line.
#ifdef WINDOW_CHECK
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int pid = atoi(argv[1]);
  NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  for (NSDictionary *window in windows) {
    if ([window[(id)kCGWindowOwnerPID] intValue] != pid) continue;
    printf("%g %d\n", [window[(id)kCGWindowAlpha] doubleValue], [window[(id)kCGWindowLayer] intValue]);
  }
  return 0;
}
#else
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <errno.h>
#import <objc/runtime.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <sys/socket.h>
#import <unistd.h>

static const char *logPath;

static void note(const char *what) {
  if (!logPath) return;
  FILE *f = fopen(logPath, "a");
  if (!f) return;
  fprintf(f, "%d %s\n", getpid(), what);
  fclose(f);
}

// The copy needs no network: this stops its updater, core updater and telemetry.
static int refuseNetwork(int fd, const struct sockaddr *addr, socklen_t len) {
  if (addr && (addr->sa_family == AF_INET || addr->sa_family == AF_INET6)) {
    note("network refused");
    errno = ENETUNREACH;
    return -1;
  }
  return connect(fd, addr, len);
}
static void noBeep(void) {}
__attribute__((used)) static struct {
  const void *replacement;
  const void *original;
} interposers[] __attribute__((section("__DATA,__interpose"))) = {
    {(const void *)refuseNetwork, (const void *)connect},
    {(const void *)noBeep, (const void *)NSBeep},
};

// A crash report dialog would come to the front; leave quietly instead.
static void quietExit(int sig) { _exit(128 + sig); }

static BOOL answerNo(id self, SEL _cmd) { return NO; }
static BOOL answerYes(id self, SEL _cmd, id arg) { return YES; }
static void doNothing(id self, SEL _cmd) {}
static void doNothingWith(id self, SEL _cmd, id arg) {}
static void refuseActivation(id self, SEL _cmd, BOOL ignoringOthers) { note("activation refused"); }
static BOOL pretendActivated(id self, SEL _cmd, NSUInteger options) {
  note("activation refused");
  return YES;
}

// The window stays on its screen, so GPUI's display link keeps a real display,
// but it shows nothing, sits under every normal window and lets clicks through.
static IMP originalOrderWindow, originalSetAlpha, originalSetLevel, originalSetIgnores;

static void hide(NSWindow *window) {
  ((void (*)(id, SEL, CGFloat))originalSetAlpha)(window, @selector(setAlphaValue:), 0);
  ((void (*)(id, SEL, NSInteger))originalSetLevel)(window, @selector(setLevel:), NSNormalWindowLevel - 1);
  ((void (*)(id, SEL, BOOL))originalSetIgnores)(window, @selector(setIgnoresMouseEvents:), YES);
  window.hasShadow = NO;
  window.collectionBehavior = NSWindowCollectionBehaviorTransient |
                              NSWindowCollectionBehaviorIgnoresCycle |
                              NSWindowCollectionBehaviorStationary;
  // GPUI's window classes answer YES themselves, so replace it on the class.
  Class cls = object_getClass(window);
  class_replaceMethod(cls, @selector(canBecomeKeyWindow), (IMP)answerNo, "c@:");
  class_replaceMethod(cls, @selector(canBecomeMainWindow), (IMP)answerNo, "c@:");
}

static void orderBehind(NSWindow *self, SEL _cmd, NSWindowOrderingMode mode, NSInteger other) {
  void (*order)(id, SEL, NSWindowOrderingMode, NSInteger) = (void *)originalOrderWindow;
  if (mode == NSWindowOut) return order(self, _cmd, mode, other);
  hide(self);
  order(self, @selector(orderWindow:relativeTo:), NSWindowBelow, 0);
  note("window ordered, hidden");
}
static void orderFrontHidden(NSWindow *self, SEL _cmd, id sender) {
  orderBehind(self, @selector(orderWindow:relativeTo:), NSWindowAbove, 0);
}
static void orderFrontRegardlessHidden(NSWindow *self, SEL _cmd) {
  orderBehind(self, @selector(orderWindow:relativeTo:), NSWindowAbove, 0);
}
static void keepAlpha(NSWindow *self, SEL _cmd, CGFloat alpha) {}
static void keepLevel(NSWindow *self, SEL _cmd, NSInteger level) {}
static void keepIgnoringMouse(NSWindow *self, SEL _cmd, BOOL ignores) {}

// GPUI stops its display link for a covered window, and `herdr-app shot` then
// returns the old frame for good: this is what keeps frames fresh.
static NSWindowOcclusionState alwaysVisible(NSWindow *self, SEL _cmd) {
  return NSWindowOcclusionStateVisible;
}

static IMP originalSetPolicy;
static BOOL backgroundOnly(NSApplication *self, SEL _cmd, NSApplicationActivationPolicy policy) {
  return ((BOOL(*)(id, SEL, NSApplicationActivationPolicy))originalSetPolicy)(
      self, _cmd, NSApplicationActivationPolicyProhibited);
}

// A new bundle id would otherwise ask the person for notification permission.
static void refuseNotifications(id self, SEL _cmd, NSUInteger options, void (^done)(BOOL, NSError *)) {
  if (done) done(NO, nil);
}
static void refuseDefaultApp(id self, SEL _cmd, NSURL *app, NSString *scheme, void (^done)(NSError *)) {
  if (done) done(nil);
}

static IMP swap(Class cls, SEL sel, void *replacement) {
  Method method = class_getInstanceMethod(cls, sel);
  if (!method) return NULL;
  return method_setImplementation(method, (IMP)replacement);
}

__attribute__((constructor)) static void start(void) {
  logPath = getenv("HERDR_HIDDEN_LOG");
  if (logPath) logPath = strdup(logPath);
  unsetenv("DYLD_INSERT_LIBRARIES");  // the core and terminals must not inherit this
  unsetenv("HERDR_HIDDEN_LOG");

  int fatal[] = {SIGSEGV, SIGBUS, SIGILL, SIGABRT, SIGFPE, SIGTRAP};
  for (size_t i = 0; i < sizeof fatal / sizeof *fatal; i++) signal(fatal[i], quietExit);

  Class app = [NSApplication class];
  swap(app, @selector(activateIgnoringOtherApps:), (void *)refuseActivation);
  swap(app, @selector(activate), (void *)doNothing);
  swap(app, @selector(yieldActivationToApplication:), (void *)doNothingWith);
  swap(app, @selector(hideOtherApplications:), (void *)doNothingWith);
  swap(app, @selector(unhideAllApplications:), (void *)doNothingWith);
  originalSetPolicy = swap(app, @selector(setActivationPolicy:), (void *)backgroundOnly);

  swap([NSRunningApplication class], @selector(activateWithOptions:), (void *)pretendActivated);

  Class window = [NSWindow class];
  originalOrderWindow = swap(window, @selector(orderWindow:relativeTo:), (void *)orderBehind);
  originalSetAlpha = swap(window, @selector(setAlphaValue:), (void *)keepAlpha);
  originalSetLevel = swap(window, @selector(setLevel:), (void *)keepLevel);
  originalSetIgnores = swap(window, @selector(setIgnoresMouseEvents:), (void *)keepIgnoringMouse);
  swap(window, @selector(makeKeyAndOrderFront:), (void *)orderFrontHidden);
  swap(window, @selector(orderFront:), (void *)orderFrontHidden);
  swap(window, @selector(orderFrontRegardless), (void *)orderFrontRegardlessHidden);
  swap(window, @selector(makeKeyWindow), (void *)doNothing);
  swap(window, @selector(makeMainWindow), (void *)doNothing);
  swap(window, @selector(toggleFullScreen:), (void *)doNothingWith);
  swap(window, @selector(occlusionState), (void *)alwaysVisible);

  swap([UNUserNotificationCenter class], @selector(requestAuthorizationWithOptions:completionHandler:),
       (void *)refuseNotifications);
  swap([NSWorkspace class], @selector(setDefaultApplicationAtURL:toOpenURLsWithScheme:completionHandler:),
       (void *)refuseDefaultApp);
  swap([NSWorkspace class], @selector(openURL:), (void *)answerYes);

  // If some later version of the app finds another way to the front, fail closed:
  // the window goes away and macOS gives the person's app its focus back.
  [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidBecomeActiveNotification
                                                    object:nil
                                                     queue:nil
                                                usingBlock:^(NSNotification *n) {
                                                  note("became active, leaving");
                                                  _exit(70);
                                                }];

  // Keep App Nap from slowing a window macOS sees as being in the background.
  [[[NSProcessInfo processInfo]
      beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
                        reason:@"hidden test window"] retain];
  note("loaded");
}
#endif  // WINDOW_CHECK
