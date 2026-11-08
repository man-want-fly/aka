/// <reference types="vite/client" />

// R-EV-02：构建期 define（真源见 vite.config.ts）。这些值禁止在运行时代码里手写。
declare const __AKA_BUILD_COMMIT__: string;
declare const __AKA_BUILD_DIRTY__: boolean;
declare const __AKA_BUILD_AT__: string;
declare const __AKA_BUILD_ENTRY__: string;
declare const __AKA_BUILD_FEATURES__: string[];
declare const __AKA_BUILD_NODE__: string;
