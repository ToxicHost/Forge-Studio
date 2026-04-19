"""
Gradio Stub — Lightweight replacement components for Forge Studio standalone mode.

When Studio runs in --nowebui mode, we need to call setup_ui() on the
ScriptRunners so extension arg indices get populated. But setup_ui()
triggers script.ui() calls, which create real Gradio widgets — widgets
that try to render into a DOM that doesn't exist.

The solution: monkey-patch the real gradio module's component classes
with lightweight stubs BEFORE calling setup_ui(). Every extension that
did `import gradio as gr` at module level already has `gr` bound to
the real gradio module. Patching gradio.Slider = StubSlider means
their `gr.Slider(...)` calls return our stubs instead.

The stubs capture declarations (label, value, min, max, choices, etc.)
and expose the same attributes the ScriptRunner reads. They do NOT
render, communicate over WebSocket, or fire .change() callbacks.

Usage (in api_only_worker, after boot but before setup_ui):

    from gradio_stub import install_stub
    install_stub()
    # Now call setup_ui() — extensions get stub components
"""


# =========================================================================
# LAYOUT CONTEXT STACK
# =========================================================================
# Tracks which LayoutBlock we're currently inside so components know
# their parent container. This is how we reconstruct grouping info
# for the extension manifest — we can detect which controls were
# created inside which Column/Group/Accordion/Row.

_context_stack = []


# =========================================================================
# STUB COMPONENT BASE
# =========================================================================

class StubComponent:
    """Base for all stub Gradio components.

    Stores every kwarg as an attribute so that ScriptRunner's
    create_script_ui_inner() can read .label, .value, .minimum, etc.
    """

    _type = "component"
    _next_id = 900000  # Start high to avoid colliding with real components

    def __init__(self, **kwargs):
        # Assign a unique _id — real Gradio's event system reads this
        # when stub components are passed as inputs/outputs to .change() etc.
        StubComponent._next_id += 1
        self._id = StubComponent._next_id

        self.label = kwargs.get("label", "")
        self.value = kwargs.get("value", None)
        self.visible = kwargs.get("visible", True)
        self.elem_id = kwargs.get("elem_id", None)
        self.elem_classes = kwargs.get("elem_classes", None)
        self.interactive = kwargs.get("interactive", None)
        self.custom_script_source = None  # Set by ScriptRunner

        # Track which layout container this component was created inside
        self._parent = _context_stack[-1] if _context_stack else None
        # Register with parent so the tree builder can walk children
        if self._parent is not None and hasattr(self._parent, '_components'):
            self._parent._components.append(self)

        # Store everything — extensions may use attrs we don't anticipate
        for k, v in kwargs.items():
            if not hasattr(self, k):
                setattr(self, k, v)

    # --- Event handlers (no-ops, but .change() captures fn/outputs for probing) ---
    def change(self, fn=None, inputs=None, outputs=None, **kwargs):
        if fn is not None and outputs:
            if not hasattr(self, '_change_handlers'):
                self._change_handlers = []
            self._change_handlers.append({
                'fn': fn,
                'inputs': inputs or [],
                'outputs': outputs or [],
            })
        return self

    def click(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def input(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def select(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def submit(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def release(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def blur(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def focus(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def upload(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def clear(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def then(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def __repr__(self):
        return f"<Stub {self._type}: {self.label!r} = {self.value!r}>"


# =========================================================================
# SPECIFIC COMPONENT TYPES
# =========================================================================
# Each sets _type for the manifest and ensures type-specific defaults.

class Slider(StubComponent):
    _type = "slider"

    def __init__(self, minimum=0, maximum=100, step=1, value=None, **kwargs):
        if value is None:
            value = minimum
        kwargs["value"] = value
        super().__init__(**kwargs)
        self.minimum = minimum
        self.maximum = maximum
        self.step = step


class Checkbox(StubComponent):
    _type = "checkbox"

    def __init__(self, value=False, **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)


class Dropdown(StubComponent):
    _type = "dropdown"

    def __init__(self, choices=None, value=None, **kwargs):
        self.choices = choices or []
        # Normalize tuple choices: ("display", "value") → "display"
        self._raw_choices = self.choices
        self.choices = [c[0] if isinstance(c, tuple) else c for c in self.choices]
        if value is None and self.choices:
            value = self.choices[0]
        kwargs["value"] = value
        super().__init__(**kwargs)
        self.type = kwargs.get("type", "value")


class Radio(StubComponent):
    _type = "radio"

    def __init__(self, choices=None, value=None, **kwargs):
        self.choices = choices or []
        self.choices = [c[0] if isinstance(c, tuple) else c for c in self.choices]
        if value is None and self.choices:
            value = self.choices[0]
        kwargs["value"] = value
        super().__init__(**kwargs)


class Textbox(StubComponent):
    _type = "textbox"

    def __init__(self, value="", **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)
        self.lines = kwargs.get("lines", 1)
        self.placeholder = kwargs.get("placeholder", None)
        self.type = kwargs.get("type", "text")


class Number(StubComponent):
    _type = "number"

    def __init__(self, value=0, **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)
        self.minimum = kwargs.get("minimum", None)
        self.maximum = kwargs.get("maximum", None)
        self.step = kwargs.get("step", 1)


class Image(StubComponent):
    _type = "image"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)
        self.type = kwargs.get("type", "numpy")
        self.source = kwargs.get("source", "upload")
        self.tool = kwargs.get("tool", None)
        self.height = kwargs.get("height", None)
        self.width = kwargs.get("width", None)


class HTML(StubComponent):
    _type = "html"

    def __init__(self, value="", **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)


class Markdown(StubComponent):
    _type = "markdown"

    def __init__(self, value="", **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)


class Button(StubComponent):
    _type = "button"

    def __init__(self, value="Button", **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)
        self.variant = kwargs.get("variant", "secondary")


class State(StubComponent):
    _type = "state"

    def __init__(self, value=None, **kwargs):
        kwargs["value"] = value
        super().__init__(**kwargs)


class Gallery(StubComponent):
    _type = "gallery"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class Plot(StubComponent):
    _type = "plot"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class ColorPicker(StubComponent):
    _type = "colorpicker"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", "#000000")
        super().__init__(**kwargs)


class File(StubComponent):
    _type = "file"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class Dataframe(StubComponent):
    _type = "dataframe"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class HighlightedText(StubComponent):
    _type = "highlightedtext"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class JSON(StubComponent):
    _type = "json"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class Label(StubComponent):
    _type = "label"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class Audio(StubComponent):
    _type = "audio"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


class Video(StubComponent):
    _type = "video"

    def __init__(self, **kwargs):
        kwargs.setdefault("value", None)
        super().__init__(**kwargs)


# =========================================================================
# LAYOUT CONTEXT MANAGERS
# =========================================================================
# These need to be both callable (gr.Row()) and usable as context managers.
# They record layout info for the manifest but don't render anything.

class LayoutBlock:
    """Base for layout context managers (Row, Column, Group, Accordion, Tab, Blocks)."""

    _type = "layout"

    def __init__(self, **kwargs):
        StubComponent._next_id += 1
        self._id = StubComponent._next_id

        self.visible = kwargs.get("visible", True)
        self.elem_id = kwargs.get("elem_id", None)
        self.label = kwargs.get("label", "")

        # Track parent layout and child layouts/components
        self._parent = _context_stack[-1] if _context_stack else None
        self._children = []    # child LayoutBlocks
        self._components = []  # direct StubComponent children (for tree building)
        if self._parent is not None and hasattr(self._parent, '_children'):
            self._parent._children.append(self)

        for k, v in kwargs.items():
            if not hasattr(self, k):
                setattr(self, k, v)

    def __enter__(self):
        _context_stack.append(self)
        return self

    def __exit__(self, *args):
        if _context_stack and _context_stack[-1] is self:
            _context_stack.pop()

    # Some extensions call .change() etc. on layout blocks too
    def change(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self

    def click(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self


class Row(LayoutBlock):
    _type = "row"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.variant = kwargs.get("variant", "default")


class Column(LayoutBlock):
    _type = "column"

    def __init__(self, scale=1, min_width=320, **kwargs):
        super().__init__(**kwargs)
        self.scale = scale
        self.min_width = min_width


class Group(LayoutBlock):
    _type = "group"


class Accordion(LayoutBlock):
    _type = "accordion"

    def __init__(self, label="", open=False, **kwargs):
        kwargs["label"] = label
        super().__init__(**kwargs)
        self.open = open


class Tab(LayoutBlock):
    _type = "tab"

    def __init__(self, label="", **kwargs):
        kwargs["label"] = label
        super().__init__(**kwargs)


class TabItem(Tab):
    """Alias — some extensions use gr.TabItem instead of gr.Tab."""
    pass


class Tabs(LayoutBlock):
    _type = "tabs"


class Blocks(LayoutBlock):
    _type = "blocks"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.fns = []

    def launch(self, *args, **kwargs):
        pass

    def queue(self, *args, **kwargs):
        return self

    def close(self):
        pass

    def load(self, fn=None, inputs=None, outputs=None, **kwargs):
        return self


# =========================================================================
# FUNCTIONS
# =========================================================================

def update(**kwargs):
    """gr.update() — returns a dict of updates. In real Gradio this
    triggers UI mutations. In the stub it's just a dict."""
    return kwargs


# gr.skip() — sentinel for skipping updates
class _Skip:
    def __repr__(self):
        return "gr.skip()"

_skip_sentinel = _Skip()

def skip():
    return _skip_sentinel


def Warning(message=""):
    """gr.Warning() — no-op in standalone mode."""
    pass


def Info(message=""):
    """gr.Info() — no-op in standalone mode."""
    pass


def Error(message=""):
    """gr.Error() — no-op in standalone mode."""
    pass


# =========================================================================
# MODULE INSTALLATION — MONKEY-PATCH APPROACH
# =========================================================================
# Instead of replacing sys.modules['gradio'], we patch the real gradio
# module's component classes so that all existing `gr` references (already
# bound in extension modules) get our stubs when they call gr.Slider() etc.

_ORIGINALS = {}  # name → original class, for restoration if needed


def install_stub():
    """Monkey-patch the real gradio module so component constructors
    return StubComponents instead of real Gradio widgets.

    Call this AFTER boot completes but BEFORE calling setup_ui().
    Idempotent — safe to call multiple times.
    """
    import gradio as gr

    # Already patched (possibly by modules/gradio_stub.py or a prior call)
    if getattr(gr, '_studio_stub_installed', False):
        print("[Gradio Stub] Already installed, skipping")
        return

    # Map of names to our stub classes
    stubs = {
        "Slider": Slider,
        "Checkbox": Checkbox,
        "Dropdown": Dropdown,
        "Radio": Radio,
        "Textbox": Textbox,
        "Number": Number,
        "Image": Image,
        "HTML": HTML,
        "Markdown": Markdown,
        "Button": Button,
        "State": State,
        "Gallery": Gallery,
        "Plot": Plot,
        "ColorPicker": ColorPicker,
        "File": File,
        "Dataframe": Dataframe,
        "HighlightedText": HighlightedText,
        "JSON": JSON,
        "Label": Label,
        "Audio": Audio,
        "Video": Video,
        # Layout
        "Row": Row,
        "Column": Column,
        "Group": Group,
        "Accordion": Accordion,
        "Tab": Tab,
        "TabItem": TabItem,
        "Tabs": Tabs,
        "Blocks": Blocks,
        # Functions
        "update": update,
        "skip": skip,
        "Warning": Warning,
        "Info": Info,
        "Error": Error,
    }

    for name, stub_cls in stubs.items():
        if hasattr(gr, name):
            _ORIGINALS[name] = getattr(gr, name)
        setattr(gr, name, stub_cls)

    gr._studio_stub_installed = True
    print("[Gradio Stub] Patched gradio — component calls now return stub objects")


def get_real_blocks():
    """Return the real gr.Blocks class (saved before patching).

    Used to wrap setup_ui() calls so that extensions using real Gradio
    components (like InputAccordion) have a valid Blocks context.
    """
    return _ORIGINALS.get("Blocks")


def uninstall_stub():
    """Restore original gradio classes."""
    import gradio as gr

    for name, original in _ORIGINALS.items():
        setattr(gr, name, original)

    _ORIGINALS.clear()
    print("[Gradio Stub] Restored original gradio classes")
