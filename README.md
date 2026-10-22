# NetRexx 

This is the home of IDE plugins for NetRexx.

This repository holds the sourcecode of the client-side plugin components for the NetRexx Language Server Protocol (LSP) and Debug Adapter Protocol (DAP) servers.<br>
The LSP and DAP server-side engines are part of the NetRexx package at https://sourceforge.net/projects/netrexx/.<br>
NetRexx's homepage is at https://www.netrexx.org/

## Language Server Protocol (LSP) Functionality

The Language Server handles any **.nrx** file as NetRexx source code. It includes the following features:
* **Diagnostics**: Regenerated on each file change or save.
* **Document Symbols**: Generates outlines in Structure for classes and methods.
* **Textmate** syntax highlighting.

## Debug Adapter Protocol (DAP) Functionality

The Debug Server provides debugging support for NetRexx source code.<br>
The debugger starts the NetRexx source file(s) in interpreted mode.<br>
Breakpoints can be set in the **.nrx** file. Execution can be single-stepped, local variables and properties can be examined and updated.


