// Presses "Allow for this session" on the Claude desktop card that asks to let Claude use apps
// (computer use), once a card showing <reason> is up: its ⌘↩ shortcut first, a click if that
// does nothing. Prints how it went on stdout (`approved <how>` or `failed <why>`), and `waiting`
// on stderr while it waits.
//
//   osascript -l JavaScript approve-access-card.js <reason> [timeoutSec]
ObjC.import('ApplicationServices')
ObjC.import('AppKit')
ObjC.import('CoreGraphics')

const CLAUDE = 'com.anthropic.claudefordesktop'
// The card's Allow button announces its shortcut as aria-keyshortcuts; Deny's is Escape.
const ALLOW_SHORTCUT = 'Meta+Enter'
const RETURN_KEY = 36
// How far above the Allow button the card's reason text sits, at most.
const CARD_DEPTH = 4

function run(argv) {
  const reason = normalize(argv[0] || '')
  const timeoutMs = Number(argv[1] || 600) * 1000
  if (!reason) return 'failed no reason to recognise the card by'
  if (!$.AXIsProcessTrusted()) return 'failed this process has no Accessibility permission'

  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(CLAUDE)
  if (apps.count === 0) return 'failed the Claude app is not running'
  const claude = apps.objectAtIndex(0)
  const pid = claude.processIdentifier
  const root = $.AXUIElementCreateApplication(pid)
  // Chromium builds its accessibility tree only once an assistive app asks for it.
  $.AXUIElementSetAttributeValue(root, $('AXManualAccessibility'), $.kCFBooleanTrue)

  const start = Date.now()
  let card
  while (!(card = findCard(root, reason))) {
    if (Date.now() - start > timeoutMs) return 'failed no card showed up'
    console.log('waiting')
    delay(0.5)
  }
  while (isScreenLocked()) {
    if (Date.now() - start > timeoutMs) return 'failed the screen stayed locked'
    console.log('waiting')
    delay(1)
  }
  // Let the card finish drawing before it is answered.
  delay(0.4)

  const isGone = () => {
    for (let i = 0; i < 8; i++) {
      if (!findCard(root, reason)) return true
      delay(0.25)
    }
    return false
  }
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication
  const giveBackFocus = () => {
    if (front && !front.isEqual(claude)) front.activateWithOptions(0)
  }
  showWindow(claude, card.allow)

  // ⌘↩ answers the card only while it is the one card up and no draft waits in the prompt,
  // which the same keys would send.
  if (card.count === 1 && !hasDraft(root)) {
    postKey(event => $.CGEventPostToPid(pid, event))
    if (isGone()) return 'approved shortcut'

    claude.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)
    delay(0.3)
    postKey(event => $.CGEventPost($.kCGHIDEventTap, event))
    const isAnswered = isGone()
    giveBackFocus()
    if (isAnswered) return 'approved shortcut'
  }

  $.AXUIElementPerformAction(card.allow, $('AXScrollToVisible'))
  claude.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)
  delay(0.3)
  const clicked = click(card.allow)
  const isAnswered = clicked && isGone()
  giveBackFocus()
  return isAnswered ? 'approved click' : 'failed the card stayed up'
}

const normalize = text => text.replace(/\s+/g, ' ').trim()

const get = (el, attr) => {
  const ref = Ref()
  return $.AXUIElementCopyAttributeValue(el, $(attr), ref) === 0 ? ref[0] : undefined
}

// An attribute holding an element comes back as a raw reference.
const getElement = (el, attr) => {
  const ref = get(el, attr)
  return ref ? ObjC.castRefToObject(ref) : undefined
}

const getText = (el, attr) => {
  const v = get(el, attr)
  if (v === undefined || v === null) return ''
  try {
    const s = ObjC.unwrap(ObjC.castRefToObject(v))
    return typeof s === 'string' ? s : ''
  } catch (e) {
    return ''
  }
}

const children = el => {
  const v = get(el, 'AXChildren')
  if (!v) return []
  const list = ObjC.castRefToObject(v)
  const out = []
  for (let i = 0; i < list.count; i++) out.push(list.objectAtIndex(i))
  return out
}

const containsText = (el, text) =>
  (getText(el, 'AXRole') === 'AXStaticText' && normalize(getText(el, 'AXValue')) === text) ||
  children(el).some(k => containsText(k, text))

// The card's Allow button, and how many Allow-shortcut buttons are up in all.
const findCard = (root, reason) => {
  const allows = []
  const walk = el => {
    if (getText(el, 'AXRole') === 'AXButton' && getText(el, 'AXKeyShortcutsValue') === ALLOW_SHORTCUT) allows.push(el)
    children(el).forEach(walk)
  }
  walk(root)

  for (const allow of allows) {
    if (!/^allow\b/i.test(getText(allow, 'AXTitle') || getText(allow, 'AXDescription'))) continue
    let el = allow
    for (let up = 0; up < CARD_DEPTH && el; up++) {
      el = getElement(el, 'AXParent')
      if (el && containsText(el, reason)) return { allow, count: allows.length }
    }
  }
  return undefined
}

const hasDraft = root => {
  const focused = getElement(root, 'AXFocusedUIElement')
  if (!focused) return false
  return /^AX(TextArea|TextField)$/.test(getText(focused, 'AXRole')) && getText(focused, 'AXValue').trim() !== ''
}

// Unhides the app and unminimizes the window the card is in, so keys and clicks reach it.
const showWindow = (claude, el) => {
  if (claude.hidden) {
    claude.unhide
    delay(0.3)
  }
  let win = el
  while (win && getText(win, 'AXRole') !== 'AXWindow') win = getElement(win, 'AXParent')
  if (win && ObjC.unwrap(ObjC.castRefToObject(get(win, 'AXMinimized') ?? $.kCFBooleanFalse)) === true) {
    $.AXUIElementSetAttributeValue(win, $('AXMinimized'), $.kCFBooleanFalse)
    delay(0.5)
  }
}

const isScreenLocked = () => {
  const session = $.CGSessionCopyCurrentDictionary()
  if (!session) return false
  const locked = ObjC.castRefToObject(session).objectForKey('CGSSessionScreenIsLocked')
  return !locked.isNil() && ObjC.unwrap(locked) === true
}

const postKey = post => {
  for (const isDown of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, RETURN_KEY, isDown)
    $.CGEventSetFlags(event, $.kCGEventFlagMaskCommand)
    post(event)
    delay(0.05)
  }
}

// An AXValue's description reads "{value = x:12 y:34 ...}" or "{value = w:56 h:78 ...}".
const readGeometry = (el, attr) => {
  const v = get(el, attr)
  if (!v) return undefined
  const description = ObjC.unwrap(ObjC.castRefToObject(v).description)
  const n = key => Number((description.match(new RegExp(`${key}:(-?[0-9.]+)`)) || [])[1])
  return attr === 'AXPosition' ? { x: n('x'), y: n('y') } : { w: n('w'), h: n('h') }
}

// A real click: the card ignores an accessibility press. The pointer goes back where it was.
const click = el => {
  const pos = readGeometry(el, 'AXPosition')
  const size = readGeometry(el, 'AXSize')
  if (!pos || !size || [pos.x, pos.y, size.w, size.h].some(Number.isNaN)) return false
  const at = $.CGPointMake(pos.x + size.w / 2, pos.y + size.h / 2)
  const was = $.CGEventGetLocation($.CGEventCreate(null))
  const mouse = (type, point) => $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft))
  mouse($.kCGEventMouseMoved, at)
  delay(0.15)
  mouse($.kCGEventLeftMouseDown, at)
  delay(0.08)
  mouse($.kCGEventLeftMouseUp, at)
  delay(0.1)
  mouse($.kCGEventMouseMoved, was)
  return true
}
