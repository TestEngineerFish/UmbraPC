// 密码保险箱 数据模型（三层 + 模块化控件）。渲染层同名类型自行声明（跨 tsconfig 不共享）。

export interface VaultMeta {
  v: number;                 // 版本
  salt: string;              // base64，KDF 盐（账户级）
  verifier: string;          // hex，SHA256(authHash)，服务器/本地校验主密码
  secretKeyEnc: string;      // base64，safeStorage 加密后的 Secret Key（设备绑定）
  vaults: VaultInfo[];       // 身份库列表 + 各自被 AUK 包装的 VaultKey
  autoLockMin: number;       // 自动锁定分钟（0=不自动锁）
  createdAt: number;
}
export interface VaultInfo {
  id: string;
  name: string;
  owner: string;             // self / dad / mom / wife / 自定义
  icon: string;
  order: number;
  keyWrapped: string;        // 被 AUK 包装的 VaultKey 密文（wrapKey）
}

// 类型（文件夹）：每个身份库各自一套。
export interface VaultType { id: string; name: string; icon: string; order: number }

// 附件元数据（字节单独加密存文件）。
export interface Attachment { id: string; name: string; mime: string; size: number; w?: number; h?: number; addedAt: number }

// 控件（Block）：type ∈ account/secret/text/field/images/files。
export interface Block { id: string; type: string; label?: string; data: Record<string, unknown> }

// 记录。
export interface Item {
  id: string;
  typeId: string;            // 所属类型（可改=移动）
  title: string;
  icon?: string;
  favorite?: boolean;
  tags?: string[];
  blocks: Block[];
  attachments: Attachment[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

// 一个身份库解密后的内容（存 v-<id>.enc）。
export interface VaultData { types: VaultType[]; items: Item[] }
