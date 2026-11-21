"""Command scopes must not leak between registry modules."""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR))
SPEC = importlib.util.spec_from_file_location(
    "placement_doctor", TOOLS_DIR / "placement-doctor.py"
)
assert SPEC and SPEC.loader
placement_doctor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = placement_doctor
SPEC.loader.exec_module(placement_doctor)


class PlacementDoctorTests(unittest.TestCase):
    def test_transient_access_preserves_one_required_home(self):
        command = placement_doctor.Command(
            'paragraph.style.body', 'paragraph', 'viewBar',
            transient_homes={'selectionToolbar', 'contextMenu'},
        )
        command.containers = {'viewBar', 'selectionToolbar', 'contextMenu'}
        self.assertEqual(placement_doctor.placement_problems(command), [])
        command.containers.remove('viewBar')
        self.assertTrue(placement_doctor.placement_problems(command))

    def test_transient_access_cannot_authorize_second_persistent_home(self):
        command = placement_doctor.Command(
            'paragraph.style.body', 'paragraph', 'viewBar',
            transient_homes={'projectBar'},
        )
        command.containers = {'viewBar', 'projectBar'}
        self.assertTrue(placement_doctor.placement_problems(command))
        command.transient_homes = set()
        command.containers = {'viewBar', 'selectionToolbar'}
        self.assertTrue(placement_doctor.placement_problems(command))

    def test_parses_only_explicit_transient_declarations(self):
        source = """
const NAV_VIEWS = []
const PARAGRAPH_STYLES = ['', 'heading']
const PARAGRAPH_STYLE_COMMANDS = PARAGRAPH_STYLES.map(style => ({
  id: `paragraph.style.${style}`,
  scope: 'paragraph',
  transientHomes: ['selectionToolbar', 'contextMenu'],
}))
const COMMANDS = [{
  id: 'editor.quickEdit',
  scope: 'caret',
  transientHomes: ['selectionToolbar'],
}, {
  id: 'text.bold',
  scope: 'selection',
}]
"""
        commands = placement_doctor.parse_registry([source], {
            'paragraph': 'viewBar', 'caret': 'contextMenu',
            'selection': 'selectionToolbar', 'application': 'menuBar',
        })
        self.assertEqual(commands[0].transient_homes, {'selectionToolbar'})
        self.assertEqual(commands[1].transient_homes, set())
        self.assertEqual(commands[2].transient_homes, {'selectionToolbar', 'contextMenu'})

    def test_generated_family_does_not_change_previous_module_scope(self):
        with tempfile.TemporaryDirectory() as folder:
            registry = Path(folder) / "commands.ts"
            registry.write_text(
                "import { EDITOR_COMMANDS } from './editorCommands'\n"
                "const NAV_VIEWS = ['editor']\n"
                "const COMMANDS = [{\n"
                "  id: 'app.about',\n"
                "  scope: 'application',\n"
                "}]\n",
                encoding="utf-8",
            )
            registry.with_name("editorCommands.ts").write_text(
                "const PARAGRAPH_STYLES = ['', 'heading']\n"
                "const GENERATED = PARAGRAPH_STYLES.map(style => ({\n"
                "  id: `paragraph.style.${style}`,\n"
                "  scope: 'paragraph',\n"
                "}))\n"
                "const EDITOR_COMMANDS = [{\n"
                "  id: 'text.bold',\n"
                "  scope: 'selection',\n"
                "  home: 'contextMenu',\n"
                "}]\n",
                encoding="utf-8",
            )
            commands = placement_doctor.parse_registry(
                placement_doctor.registry_sources(registry),
                {
                    "application": "menuBar",
                    "paragraph": "viewBar",
                    "selection": "selectionBar",
                },
            )
            self.assertEqual(
                [(command.id, command.home) for command in commands],
                [
                    ("app.about", "menuBar"),
                    ("text.bold", "contextMenu"),
                    ("nav.editor", "menuBar"),
                    ("paragraph.style.body", "viewBar"),
                    ("paragraph.style.heading", "viewBar"),
                ],
            )
            self.assertTrue(commands[1].declared_home)


if __name__ == "__main__":
    unittest.main()
