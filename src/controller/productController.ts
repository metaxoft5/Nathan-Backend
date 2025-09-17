import { Request, Response } from "express";
import { PrismaClient } from "../generated/prisma";

const prisma = new PrismaClient();

// Helper: resolve a Flavor by provided name (case-insensitive) or alias
const resolveFlavorByNameOrAlias = async (nameLike: string) => {
  const candidate = String(nameLike || "").trim();
  if (!candidate) return null;
  const flavor = await prisma.flavor.findFirst({
    where: {
      OR: [
        { name: { equals: candidate, mode: "insensitive" } },
        { aliases: { has: candidate } },
      ],
    },
  });
  return flavor;
};

// Create new product (Admin only)
export const createProduct = async (req: Request, res: Response) => {
  try {
    // Check if request body exists
    if (!req.body) {
      return res.status(400).json({ message: "Request body is required" });
    }

    const { name, description, price, stock, category } = req.body;

    // Handle uploaded image
    let imageUrl = null;
    if (req.file) {
      imageUrl = `/uploads/products/${req.file.filename}`;
    }

    // Validate required fields
    if (!name || !price || !stock || !category) {
      return res.status(400).json({
        message:
          "Missing required fields: name, price, stock, category are required",
      });
    }

    // Check if user is admin
    const user = (req as any).user;
    if (user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    // Generate a unique SKU if not provided
    const sku = `PROD-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    // Parse flavors from multipart or JSON
    let parsedFlavors: Array<{ name?: string; quantity?: number }> = [];
    try {
      const raw = (req.body as any).flavors;
      if (raw) {
        parsedFlavors = Array.isArray(raw)
          ? (raw as any[])
          : JSON.parse(String(raw));
      }
    } catch {
      parsedFlavors = [];
    }

    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name,
          description,
          price: parseFloat(price),
          stock: parseInt(stock),
          category,
          imageUrl,
          sku,
        },
      });

      // Persist ProductFlavor rows if provided
      if (Array.isArray(parsedFlavors) && parsedFlavors.length > 0) {
        for (const f of parsedFlavors) {
          const qty = Number((f as any)?.quantity ?? 1);
          const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
          const flavorName = String((f as any)?.name || "").trim();
          if (!flavorName) continue;
          const flavor = await resolveFlavorByNameOrAlias(flavorName);
          if (!flavor) continue; // Skip unknown flavors silently
          await tx.productFlavor.upsert({
            where: {
              productId_flavorId: { productId: product.id, flavorId: flavor.id },
            },
            update: { quantity },
            create: {
              productId: product.id,
              flavorId: flavor.id,
              quantity,
            },
          });
        }
      }

      return product;
    });

    res
      .status(201)
      .json({ message: "Product created successfully", product: result });
  } catch (err) {
    console.error("Create product error:", err);
    res.status(500).json({ message: "Error creating product" });
  }
};

// Get all active products
export const getAllProducts = async (req: Request, res: Response) => {
  try {
    const { category, search, page = 1, limit = 10 } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: any = { isActive: true };

    if (category) {
      where.category = category;
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: "insensitive" } },
        { description: { contains: search as string, mode: "insensitive" } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        include: {
          productFlavors: {
            include: {
              flavor: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.product.count({ where }),
    ]);

    // Transform products to include flavor information
    const transformedProducts = products.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      stock: product.stock,
      category: product.category,
      sku: product.sku,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      flavors: product.productFlavors.map((pf) => ({
        id: pf.flavor.id,
        name: pf.flavor.name,
        quantity: pf.quantity,
      })),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    }));

    res.json({
      products: transformedProducts,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching products" });
  }
};

// Get single product by ID
export const getProductById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const product = await prisma.product.findFirst({
      where: { id, isActive: true },
      include: {
        productFlavors: {
          include: {
            flavor: true,
          },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Transform product to include flavor information
    const transformedProduct = {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      stock: product.stock,
      category: product.category,
      sku: product.sku,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      flavors: product.productFlavors.map((pf) => ({
        id: pf.flavor.id,
        name: pf.flavor.name,
        quantity: pf.quantity,
      })),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };

    res.json(transformedProduct);
  } catch (err) {
    res.status(500).json({ message: "Error fetching product" });
  }
};

// Update product (Admin only)
export const updateProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if request body exists
    if (!req.body) {
      return res.status(400).json({ message: "Request body is required" });
    }

    const { name, description, price, stock, category, imageUrl, isActive } =
      req.body;

    // Check if user is admin
    const user = (req as any).user;
    if (user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    // Attempt to capture flavors from multipart or JSON body
    let parsedFlavors: Array<{ name?: string; quantity?: number }> | undefined;
    try {
      const raw = (req.body as any).flavors;
      if (raw !== undefined) {
        parsedFlavors = Array.isArray(raw)
          ? (raw as any[])
          : JSON.parse(String(raw));
      }
    } catch {
      parsedFlavors = undefined;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          name,
          description,
          price: price ? parseFloat(price) : undefined,
          stock: stock ? parseInt(stock) : undefined,
          category,
          imageUrl,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        },
      });

      // If flavors were provided, replace ProductFlavor set accordingly
      if (parsedFlavors) {
        await tx.productFlavor.deleteMany({ where: { productId: id } });
        for (const f of parsedFlavors) {
          const qty = Number((f as any)?.quantity ?? 1);
          const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
          const flavorName = String((f as any)?.name || "").trim();
          if (!flavorName) continue;
          const flavor = await resolveFlavorByNameOrAlias(flavorName);
          if (!flavor) continue; // Skip unknown flavors silently
          await tx.productFlavor.create({
            data: {
              productId: id,
              flavorId: flavor.id,
              quantity,
            },
          });
        }
      }

      return product;
    });

    res.json({ message: "Product updated successfully", product: updated });
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ message: "Error updating product" });
  }
};

// Delete product (Admin only)
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    const user = (req as any).user;
    if (user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    await prisma.product.delete({
      where: { id },
    });

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ message: "Error deleting product" });
  }
};

// Get all products for admin (including inactive)
export const getAllProductsForAdmin = async (req: Request, res: Response) => {
  try {
    const { category, search, page = 1, limit = 10 } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const where: any = {}; // No isActive filter for admin

    if (category) {
      where.category = category;
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: "insensitive" } },
        { description: { contains: search as string, mode: "insensitive" } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: parseInt(limit as string),
        orderBy: { createdAt: "desc" },
        include: {
          productFlavors: {
            include: {
              flavor: true,
            },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    // Transform to include flavors in a UI-friendly shape
    const transformedProducts = products.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      stock: product.stock,
      category: product.category,
      sku: product.sku,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      flavors: product.productFlavors.map((pf) => ({
        id: pf.flavor.id,
        name: pf.flavor.name,
        quantity: pf.quantity,
      })),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    }));

    res.json({
      products: transformedProducts,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching products" });
  }
};

// Get product categories
export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await prisma.product.findMany({
      where: { isActive: true },
      select: { category: true },
      distinct: ["category"],
    });

    const categoryList = categories.map((cat) => cat.category);
    res.json(categoryList);
  } catch (err) {
    res.status(500).json({ message: "Error fetching categories" });
  }
};
