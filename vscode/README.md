# NetRexx Extension

Written in NetRexx for NetRexx (well, except for the vscode typescript..).

## Language Server Protocol (LSP) Functionality

The Language Server handles any **.nrx** file as NetRexx source code. It includes the following features:
* **Diagnostics**: Regenerated on each file change or save.
* **Document Symbols**: Generates outlines in Structure for classes and methods.
* **Textmate** syntax highlighting.

## Debug Adapter Protocol (DAP) Functionality

The Debug Server provides debugging support for NetRexx source code. The debugger starts the NetRexx source file(s)
in interpreted mode. Breakpoints can be set in the **.nrx** file. Execution can be single-stepped,
 local variables and properties can be examined and updated.

To debug a program, create a run/debug configuration:
* Select Run ~ Add configuration
* Select *NetRexx: Launch* from the list
Then select F5 or Run ~ Start debugging.<br>

In the Settings, you can set the program(s) to interpret, and optional arguments. If no program is specified, the currently active file is debugged. The file must have .nrx extension.

## Settings

The extension has following **workspace** settings:
* Common settings
  * **classpath** : classpath used during translation/interpretation
  * **cwd** : current working directory
  * **--log** : show JSON-RPC messages on stderr
* LSP settings
  * **--onChange=2000** : Sets the delay for interactive parsing to 2 seconds.
  * **--onChange=off** : Disables interactive parsing.
* DAP settings
  * **--rx** : Exposes the internal RxInterpreter in class instances.
  * **--cl** : Single step per clause (defaults per line).
* Debug configuration
  * **program** : program(s) to interpret, if empty, the active file is used.
  * **arguments** : arguments to the program.

Currently limited to a single thread.

Based on NetRexxC.jar 5.20-beta<br>
https://www.netrexx.org/