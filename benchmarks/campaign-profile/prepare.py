import json
import pathlib
import shutil
import subprocess
import sys

source = pathlib.Path(sys.argv[1]).resolve(strict=True)
task = pathlib.Path(sys.argv[2]).resolve()
node = pathlib.Path(sys.argv[3]).resolve(strict=True)
if task == source or source in task.parents or task in source.parents:
    raise SystemExit("Task must be outside the built source tree and its ancestors")
if task.exists():
    raise SystemExit("Fresh task directory required")
for name in ["dist", "integrations", "node_modules/.pnpm", "examples/node-test/repository"]:
    if not (source / name).is_dir():
        raise SystemExit("Missing built source input: " + name)
if not node.is_file():
    raise SystemExit("Node executable must be a file")
task.mkdir(parents=True)
for name in ["recorder.mjs", "instrument.mjs", "run.mjs", "analyze.py"]:
    shutil.copy2(pathlib.Path(__file__).parent / name, task / name)
(task / "tmp").mkdir()
for variant in ["base", "profile"]:
    producer = task / variant
    producer.mkdir()
    shutil.copytree(source / "dist", producer / "dist")
    shutil.copytree(source / "integrations", producer / "integrations")
    shutil.copy2(source / "package.json", producer / "package.json")
    (producer / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
shutil.copytree(source / "examples/node-test/repository", task / "repository")
request = json.loads((source / "examples/node-test/request.json").read_text())
request["repository"]["root"] = str(task / "repository")
request["adapter"]["executable"] = str(node)
(task / "request.json").write_text(json.dumps(request, indent=2) + "\n")
shutil.copy2(task / "recorder.mjs", task / "profile/dist/e5-recorder.mjs")
subprocess.run([str(node), str(task / "instrument.mjs"), str(task / "profile/dist")], cwd=task, check=True)
for name in ["engine/index.js", "engine/adapters/node-test-runtime.js", "core/index.js"]:
    subprocess.run([str(node), "--check", str(task / "profile/dist" / name)], check=True)
